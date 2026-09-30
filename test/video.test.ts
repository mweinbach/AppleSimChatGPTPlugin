import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket, type RawData } from "ws";
import { AppleHub, type AppleBoundary } from "../src/apple.js";
import { AccessUnitReader, LiveInputPacer, SimulatorVideo } from "../src/video.js";
import { declareH264DecodeOrder, inspectVideoAccessUnit } from "../src/video-codec.js";

const accessUnit = Buffer.from([
  0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f,
  0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
  0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21,
]);

function packet(unit: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(unit.length);
  return Buffer.concat([header, unit]);
}

function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Video test event timed out.")), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function fixture(t: TestContext, script?: string) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const devices: string[] = [];
  const touched: string[] = [];
  const video = new SimulatorVideo({
    keepAlive: id => touched.push(id),
    launch(deviceId) {
      devices.push(deviceId);
      const child = spawn(process.execPath, ["-e", script ?? `
        const frame = Buffer.from(${JSON.stringify([...packet(accessUnit)])});
        setInterval(() => process.stdout.write(frame), 30);
      `], { stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  });
  t.after(() => video.close());
  return { video, children, devices, touched };
}

async function viewer(t: TestContext, url: string) {
  const socket = new WebSocket(url);
  t.after(() => socket.terminate());
  const firstFrame = deadline(once(socket, "message")) as Promise<[RawData, boolean]>;
  await deadline(once(socket, "open"));
  return { socket, firstFrame };
}

function rejected(url: string, options?: { headers: { Host: string } }): Promise<number> {
  return deadline(new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on("error", () => {});
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Unauthorized video connection was accepted."));
    });
  }));
}

test("native video preserves complete access units across arbitrary pipe chunks", () => {
  const reader = new AccessUnitReader();
  const units: Buffer[] = [];
  const second = Buffer.from([0, 0, 1, 0x41, 0xff]);
  const bytes = Buffer.concat([packet(accessUnit), packet(second), packet(accessUnit)]);
  // Split both length headers and payloads; also deliver two whole units together.
  for (const [from, to] of [[0, 1], [1, 3], [3, 6], [6, 11], [11, bytes.length]]) {
    reader.push(bytes.subarray(from, to), unit => units.push(Buffer.from(unit)));
  }
  assert.deepEqual(units, [accessUnit, second, accessUnit]);
});

test("native video rejects zero and excessive access-unit lengths before waiting for payload", () => {
  for (const length of [0, 8 * 1024 * 1024 + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    let consumed = false;
    assert.throws(() => new AccessUnitReader().push(header, () => { consumed = true; }), /Invalid simulator video access unit/);
    assert.equal(consumed, false);
  }
});

test("issuing a stream capability binds only to loopback and starts no capture helper", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  assert.equal(new URL(stream.url).hostname, "127.0.0.1");
  assert.equal(stream.sessionId, "session-one");
  assert.equal(f.children.length, 0);
  const http = stream.url.replace(/^ws:/, "http:");
  assert.equal((await fetch(http)).status, 404);
});

test("missing capabilities and invalid Host headers cannot launch native capture", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  const origin = new URL(stream.url).origin;
  assert.equal(await rejected(`${origin}/video/${"a".repeat(48)}`), 403);
  assert.equal(await rejected(`${origin}/video/`), 403);
  assert.equal(await rejected(stream.url, { headers: { Host: "attacker.example" } }), 403);
  assert.equal(f.children.length, 0);
  // A request with the wrong Host cannot consume the real viewer's capability.
  const view = await viewer(t, stream.url);
  const [data, binary] = await view.firstFrame;
  assert.equal(binary, true);
  assert.deepEqual(data, accessUnit);
  assert.deepEqual(f.devices, ["simulator-one"]);
});

test("a capability expires before it can authorize a viewer", async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = await f.video.stream("session-one", "simulator-one");
  t.mock.timers.tick(30_000);
  t.mock.timers.reset();
  assert.equal(await rejected(stream.url), 403);
  assert.equal(f.children.length, 0);
});

test("video capabilities are single use, while two authorized viewers share one encoder", async t => {
  const f = fixture(t);
  const first = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await first.firstFrame;
  const secondStream = await f.video.stream("session-one", "simulator-one");
  const second = await viewer(t, secondStream.url);
  await second.firstFrame;
  assert.equal(await rejected(secondStream.url), 403);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.devices, ["simulator-one"]);
  assert.ok(f.touched.every(id => id === "session-one"));

  const firstClosed = deadline(once(first.socket, "close"));
  first.socket.close();
  await firstClosed;
  await deadline(once(second.socket, "message"));
  assert.equal(f.children[0]!.exitCode, null, "remaining viewers keep the helper running");
  assert.equal(f.children[0]!.signalCode, null);

  const helperExit = deadline(once(f.children[0]!, "exit"));
  second.socket.close();
  const [_code, signal] = await helperExit;
  assert.equal(signal, "SIGTERM", "the final viewer releases native capture");
});

test("HEVC and H.264 viewers keep independent encoders and codec-specific keyframe gating", async t => {
  const hevc = Buffer.from([0, 0, 1, 0x40, 1, 0xaa, 0, 0, 1, 0x42, 1, 1, 1, 0x60, 0, 0, 3, 0, 0xb0, 0, 0, 3, 0, 0, 3, 0, 0x96, 0, 0, 1, 0x44, 1, 0xbb, 0, 0, 1, 0x26, 1, 0xcc]);
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const video = new SimulatorVideo({ launch(_device, format) {
    const child = spawn(process.execPath, ["-e", `const frame = Buffer.from(${JSON.stringify([...packet(format === "hevc" ? hevc : accessUnit)])}); setInterval(() => process.stdout.write(frame), 30);`]);
    children.set(format, child);
    return child;
  } });
  t.after(() => video.close());
  const hevcStream = await video.stream("same-session", "device", "hevc");
  assert.equal(hevcStream.format, "hevc");
  const h265Viewer = await viewer(t, hevcStream.url);
  assert.deepEqual((await h265Viewer.firstFrame)[0], hevc);
  const h264Viewer = await viewer(t, (await video.stream("same-session", "device", "h264")).url);
  await h264Viewer.firstFrame;
  const relay = await video.stream("same-session", "device", "hevc");
  const batch = await video.read("same-session", relay.streamId!);
  assert.ok(batch.frames.length);
  assert.equal(inspectVideoAccessUnit(Buffer.from(batch.frames[0]!, "base64"), "hevc").hasParameterSets, true);
  assert.equal(children.size, 2, "HEVC relay shares only the HEVC encoder");
  video.stop("same-session", relay.streamId!);
  const exit = deadline(once(children.get("hevc")!, "exit"));
  h265Viewer.socket.close();
  await exit;
  await deadline(once(h264Viewer.socket, "message"));
  assert.equal(children.get("h264")!.signalCode, null, "the H.264 fallback viewer keeps its encoder");
  const fallbackExit = deadline(once(children.get("h264")!, "exit"));
  video.closeSession("same-session");
  await fallbackExit;
});

test("H.264 keyframes reach viewers and relays with decode order declared in the SPS", async t => {
  const native = Buffer.from("00000001" + "27420020ab40f0103cda" + "00000001" + "28ce3c80" + "00000001" + "65888421", "hex");
  const f = fixture(t, `process.stdout.write(Buffer.from(${JSON.stringify([...packet(native)])})); setInterval(() => {}, 1000);`);
  const declared = Buffer.from(declareH264DecodeOrder(native));
  assert.notDeepEqual(declared, native);
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  assert.deepEqual((await view.firstFrame)[0], declared);
  const relay = await f.video.stream("session-two", "simulator-two");
  assert.deepEqual((await f.video.read("session-two", relay.streamId!)).frames, [declared.toString("base64")]);
});

test("viewers joining an existing encoder receive codec parameters and a keyframe before deltas", async t => {
  const delta = Buffer.from([0, 0, 0, 1, 0x41, 0xff]);
  const f = fixture(t, `
    const key = Buffer.from(${JSON.stringify([...packet(accessUnit)])});
    const delta = Buffer.from(${JSON.stringify([...packet(delta)])});
    let frame = 0;
    setInterval(() => process.stdout.write(frame++ % 8 === 0 ? key : delta), 30);
  `);
  const first = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  assert.deepEqual((await first.firstFrame)[0], accessUnit);
  const second = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  assert.deepEqual((await second.firstFrame)[0], accessUnit, "a mid-GOP viewer starts at the next independently decodable frame");
  assert.equal(f.children.length, 1);
  assert.deepEqual((await deadline(once(second.socket, "message")))[0], delta);
});

test("a slow final viewer releases capture before its close handshake completes", async t => {
  const f = fixture(t);
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await view.firstFrame;
  view.socket.pause();
  const channels = Reflect.get(f.video, "channels") as Map<string, { clients: Set<WebSocket> }>;
  const serverSocket = [...channels.get("session-one:h264")!.clients][0]!;
  Object.defineProperty(serverSocket, "bufferedAmount", { get: () => 1024 * 1024 });
  const closed = deadline(once(view.socket, "close"));
  const exited = deadline(once(f.children[0]!, "exit"));
  const [_code, signal] = await exited;
  assert.equal(signal, "SIGTERM");
  assert.equal(channels.has("session-one:h264"), false);
  view.socket.resume();
  const [code, reason] = await closed;
  assert.equal(code, 1013);
  assert.match(reason.toString(), /too slow/);
});

test("disconnect revokes unclaimed capabilities and releases only that session's encoder", async t => {
  const f = fixture(t);
  const first = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await first.firstFrame;
  const unclaimed = await f.video.stream("session-one", "simulator-one");
  const second = await viewer(t, (await f.video.stream("session-two", "simulator-two")).url);
  await second.firstFrame;
  assert.equal(f.children.length, 2);
  const closed = deadline(once(first.socket, "close"));
  const exited = deadline(once(f.children[0]!, "exit"));
  f.video.closeSession("session-one");
  await Promise.all([closed, exited]);
  assert.equal(await rejected(unclaimed.url), 403);
  await deadline(once(second.socket, "message"));
  assert.equal(f.children[1]!.signalCode, null, "an unrelated session keeps streaming");
});

test("hub shutdown closes viewers, kills every helper, and disables the endpoint", async t => {
  const f = fixture(t);
  const first = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await first.firstFrame;
  const second = await viewer(t, (await f.video.stream("session-two", "simulator-two")).url);
  await second.firstFrame;
  const unused = await f.video.stream("session-three", "simulator-three");
  const exits = f.children.map(child => deadline(once(child, "exit")));
  const closes = [first, second].map(view => deadline(once(view.socket, "close")));
  await f.video.close();
  await Promise.all([...exits, ...closes]);
  await assert.rejects(f.video.stream("session-one", "simulator-one"), /closed/);
  await assert.rejects(fetch(unused.url.replace(/^ws:/, "http:")), /fetch failed/);
});

test("video sockets reject incoming control messages and release their helper", async t => {
  const f = fixture(t);
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await view.firstFrame;
  const closed = deadline(once(view.socket, "close"));
  const exited = deadline(once(f.children[0]!, "exit"));
  view.socket.send(JSON.stringify({ tap: [10, 20] }));
  const [code, reason] = await closed;
  assert.equal(code, 1008);
  assert.match(reason.toString(), /receive-only/);
  await exited;
});

test("malformed native output reports a viewer error and stops native capture", async t => {
  const f = fixture(t, "setInterval(() => process.stdout.write(Buffer.alloc(4)), 30)");
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  const closed = deadline(once(view.socket, "close"));
  const exited = deadline(once(f.children[0]!, "exit"));
  const [data, binary] = await view.firstFrame;
  assert.equal(binary, false);
  assert.match(JSON.parse(data.toString()).message, /Invalid simulator video access unit/);
  await Promise.all([closed, exited]);
});

test("native startup failures reach the viewer rather than leaving a pending stream", async t => {
  const video = new SimulatorVideo({ launch: () => spawn(`/missing-simulator-helper-${process.pid}`, [], { stdio: ["pipe", "pipe", "pipe"] }) });
  t.after(() => video.close());
  const view = await viewer(t, (await video.stream("session-one", "simulator-one")).url);
  const closed = deadline(once(view.socket, "close"));
  const [data, binary] = await view.firstFrame;
  assert.equal(binary, false);
  assert.match(JSON.parse(data.toString()).message, /Could not start simulator video.*ENOENT/);
  await closed;
});

test("a native helper that exits reports its diagnostic to the viewer", async t => {
  const f = fixture(t, "setTimeout(() => { process.stderr.write('Simulator display is unavailable.'); process.exitCode = 2; }, 30)");
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  const closed = deadline(once(view.socket, "close"));
  const [data, binary] = await view.firstFrame;
  assert.equal(binary, false);
  assert.deepEqual(JSON.parse(data.toString()), { type: "error", message: "Simulator display is unavailable." });
  await closed;
});

test("native JSON failures expose the error message after all diagnostics drain", async t => {
  const f = fixture(t, `setTimeout(() => {
    process.stderr.write(JSON.stringify({ event: 'attached', fps: 30 }) + '\\n');
    process.stderr.write(JSON.stringify({ event: 'error', message: 'CoreSimulator screen is unavailable.' }) + '\\n');
    process.stderr.write(JSON.stringify({ event: 'stopped', frames: 0 }) + '\\n');
    process.exitCode = 1;
  }, 30)`);
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  const closed = deadline(once(view.socket, "close"));
  const [data, binary] = await view.firstFrame;
  assert.equal(binary, false);
  assert.deepEqual(JSON.parse(data.toString()), { type: "error", message: "CoreSimulator screen is unavailable." });
  await closed;
});

test("MCP video reads relay native H.264 in bounded batches and consume the capability once", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  assert.ok(stream.streamId);
  assert.equal(f.children.length, 0);
  const pending = f.video.read("session-one", stream.streamId);
  await assert.rejects(f.video.read("session-one", stream.streamId), /already in progress/);
  const batch = await pending;
  const next = await f.video.read("session-one", stream.streamId);
  assert.equal(batch.active, true);
  assert.equal(batch.sessionId, "session-one");
  assert.equal(batch.streamId, stream.streamId);
  assert.deepEqual([batch.sequence, next.sequence], [0, 1], "batches are numbered in the order they were served");
  assert.ok(batch.frames.length > 0 && batch.frames.length <= 30);
  assert.ok([...batch.frames, ...next.frames].every(frame => Buffer.from(frame, "base64").equals(accessUnit)));
  assert.equal(f.children.length, 1);
  assert.equal(await rejected(stream.url), 403);
  await assert.rejects(f.video.read("session-two", stream.streamId), /another session/);
  f.video.stop("session-two", stream.streamId);
  assert.equal((await f.video.read("session-one", stream.streamId)).active, true, "a foreign session cannot stop the relay");
  const exited = deadline(once(f.children[0]!, "exit"));
  f.video.stop("session-one", stream.streamId);
  await exited;
  await assert.rejects(f.video.read("session-one", stream.streamId), /expired or is unavailable/);
});

test("stopping an unclaimed MCP stream revokes its URL without launching capture", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  assert.ok(stream.streamId);
  await assert.rejects(f.video.read("session-two", stream.streamId), /expired or is unavailable/);
  f.video.stop("session-two", stream.streamId);
  f.video.stop("session-one", stream.streamId);
  f.video.stop("session-one", stream.streamId);
  assert.equal(await rejected(stream.url), 403);
  await assert.rejects(f.video.read("session-one", stream.streamId), /expired or is unavailable/);
  assert.equal(f.children.length, 0);
});

test("MCP relays share capture with WebSocket viewers and release only their own viewer", async t => {
  const f = fixture(t);
  const view = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  await view.firstFrame;
  const relay = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", relay.streamId!);
  assert.equal(f.children.length, 1);
  f.video.stop("session-one", relay.streamId!);
  await deadline(once(view.socket, "message"));
  assert.equal(f.children[0]!.signalCode, null);
  const exited = deadline(once(f.children[0]!, "exit"));
  view.socket.close();
  await exited;
});

test("native errors reject pending MCP reads and release the encoder", async t => {
  const f = fixture(t, "setTimeout(() => { process.stderr.write(JSON.stringify({ event: 'error', message: 'Native video failed.' })); process.exitCode = 1; }, 30)");
  const stream = await f.video.stream("session-one", "simulator-one");
  await assert.rejects(f.video.read("session-one", stream.streamId!), /Native video failed/);
  assert.equal(f.children.length, 1);
  assert.notEqual(f.children[0]!.exitCode, null);
  assert.equal((Reflect.get(f.video, "relays") as Map<string, unknown>).size, 0);
});

test("an MCP relay with no frames returns an empty batch and stops an in-flight read promptly", async t => {
  const f = fixture(t, "setInterval(() => {}, 1000)");
  const stream = await f.video.stream("session-one", "simulator-one");
  assert.deepEqual((await f.video.read("session-one", stream.streamId!)).frames, []);
  const pending = f.video.read("session-one", stream.streamId!);
  const rejectedRead = assert.rejects(pending, /stream stopped/);
  const exited = deadline(once(f.children[0]!, "exit"));
  f.video.stop("session-one", stream.streamId!);
  await Promise.all([rejectedRead, exited]);
});

test("idle MCP relays expire, release native capture, and cannot reuse their consumed ticket", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", stream.streamId!);
  const relay = (Reflect.get(f.video, "relays") as Map<string, { idle: ReturnType<typeof setTimeout> }>).get(stream.streamId!)!;
  assert.ok(relay);
  // Advance just this existing timeout, preserving real socket and child-process events.
  const expired = Reflect.get(relay.idle, "_onTimeout") as () => void;
  const exited = deadline(once(f.children[0]!, "exit"));
  expired();
  await exited;
  assert.equal((Reflect.get(f.video, "relays") as Map<string, unknown>).size, 0);
  await assert.rejects(f.video.read("session-one", stream.streamId!), /expired or is unavailable/);
  assert.equal(await rejected(stream.url), 403);
});

type TestRelay = { frames: Buffer[]; bytes: number; waitingForKey: boolean };
function relayOf(video: SimulatorVideo, streamId: string) {
  const relay = (Reflect.get(video, "relays") as Map<string, TestRelay>).get(streamId)!;
  const deliver = Reflect.get(video, "deliver") as (relay: TestRelay, unit: Buffer, key: boolean) => void;
  return { relay, deliver: (unit: Buffer) => { const info = inspectVideoAccessUnit(unit); deliver.call(video, relay, unit, info.keyFrame && info.hasParameterSets); } };
}
const singleFrame = `process.stdout.write(Buffer.from(${JSON.stringify([...packet(accessUnit)])})); setInterval(() => {}, 1000);`;

test("MCP relay overflow discards dependent frames until a complete keyframe", async t => {
  const f = fixture(t);
  const stream = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", stream.streamId!);
  const { relay, deliver } = relayOf(f.video, stream.streamId!);
  const delta = Buffer.alloc(700 * 1024, 0x55);
  Buffer.from([0, 0, 0, 1, 0x41]).copy(delta);
  for (let index = 0; index < 4; index++) deliver(delta);
  assert.equal(relay.waitingForKey, true);
  assert.equal(relay.frames.length, 0);
  assert.equal(relay.bytes, 0);
  deliver(accessUnit);
  deliver(delta);
  assert.deepEqual(relay.frames, [accessUnit, delta]);
  assert.equal(relay.waitingForKey, false);
  assert.ok(relay.bytes <= 2 * 1024 * 1024);
  for (let index = 0; index < 30; index++) deliver(Buffer.from([0, 0, 0, 1, 0x41, 0x55]));
  assert.equal(relay.frames.length, 0, "a reader half a second behind skips to a fresh keyframe");
});

test("a keyframe larger than the MCP relay limit fails explicitly and releases capture", async t => {
  const f = fixture(t, singleFrame);
  const stream = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", stream.streamId!);
  const { deliver } = relayOf(f.video, stream.streamId!);
  const pending = assert.rejects(f.video.read("session-one", stream.streamId!), /keyframe exceeds the relay buffer limit/);
  const exited = deadline(once(f.children[0]!, "exit"));
  const largeKeyframe = Buffer.alloc(2 * 1024 * 1024 + 1, 0x55);
  accessUnit.copy(largeKeyframe);
  deliver(largeKeyframe);
  await Promise.all([pending, exited]);
  assert.equal((Reflect.get(f.video, "relays") as Map<string, unknown>).size, 0);
});

test("a pending MCP read returns as soon as the next frame arrives", async t => {
  const f = fixture(t, singleFrame);
  const stream = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", stream.streamId!);
  const { deliver } = relayOf(f.video, stream.streamId!);
  const started = performance.now();
  const reading = f.video.read("session-one", stream.streamId!);
  const delta = Buffer.from([0, 0, 0, 1, 0x41, 0x55]);
  setTimeout(() => deliver(delta), 20);
  const batch = await reading;
  assert.deepEqual(batch.frames, [delta.toString("base64")]);
  assert.ok(performance.now() - started < 200, "frames are not held for the idle wait");
});

test("a relay joining a running encoder requests a keyframe instead of waiting for one", async t => {
  const delta = Buffer.from([0, 0, 0, 1, 0x41, 0xff]);
  // The fixture sends a keyframe first, then only deltas unless asked on stdin.
  const f = fixture(t, `
    const key = Buffer.from(${JSON.stringify([...packet(accessUnit)])});
    const delta = Buffer.from(${JSON.stringify([...packet(delta)])});
    process.stdout.write(key);
    let requested = false;
    process.stdin.on("data", data => { if (String(data).includes("k\\n")) requested = true; });
    setInterval(() => { process.stdout.write(requested ? key : delta); requested = false; }, 20);
  `);
  const first = await viewer(t, (await f.video.stream("session-one", "simulator-one")).url);
  assert.deepEqual((await first.firstFrame)[0], accessUnit);
  await deadline(once(first.socket, "message"));
  const relay = await f.video.stream("session-one", "simulator-one");
  const batch = await f.video.read("session-one", relay.streamId!);
  assert.deepEqual(batch.frames.map(frame => Buffer.from(frame, "base64")), [accessUnit]);
  assert.equal(f.children.length, 1);
});

test("live input is paced into the running helper and reports unavailable input", async t => {
  const f = fixture(t, `process.stderr.write(JSON.stringify({ event: "input", available: true }) + "\\n"); ${singleFrame}`);
  assert.throws(() => f.video.input("session-one", [{ type: "home", dt: 0 }]), /needs running simulator video/);
  const stream = await f.video.stream("session-one", "simulator-one");
  await f.video.read("session-one", stream.streamId!);
  const writes: string[] = [];
  const stdin = f.children[0]!.stdin;
  const write = stdin.write.bind(stdin) as (chunk: string) => boolean;
  stdin.write = ((chunk: string) => { writes.push(chunk); return write(chunk); }) as typeof stdin.write;
  f.video.input("session-one", [{ type: "down", x: 0.25, y: 0.5, dt: 0 }, { type: "move", x: 0.3, y: 0.55, dt: 10 }, { type: "up", x: 0.3, y: 0.55, dt: 10 }, { type: "home", dt: 0 }]);
  assert.deepEqual(writes, ["t d 0.25000 0.50000\n"], "the first event is sent immediately");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(writes.join("").split("\n").filter(Boolean), ["t d 0.25000 0.50000", "t m 0.30000 0.55000", "t u 0.30000 0.55000", "home"]);
  assert.ok(f.touched.includes("session-one"), "input keeps the session alive");

  const unavailable = fixture(t, `process.stderr.write(JSON.stringify({ event: "input", available: false, message: "SimulatorKit is missing." }) + "\\n"); ${singleFrame}`);
  const other = await unavailable.video.stream("session-two", "simulator-two");
  await unavailable.video.read("session-two", other.streamId!);
  // Diagnostics arrive on stderr independently of the first frame on stdout.
  for (const end = performance.now() + 2000; ;) {
    try { assert.throws(() => unavailable.video.input("session-two", [{ type: "home", dt: 0 }]), /Live input is unavailable: SimulatorKit is missing/); break; }
    catch (error) { if (performance.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
});

test("input pacing keeps event spacing while bounding the delay of a late batch", () => {
  let now = 1000;
  const lines: string[] = [];
  const timers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => { timers.push(callback); return 0; }) as unknown as typeof setTimeout;
  try {
    const pacer = new LiveInputPacer(output => lines.push(...output.trim().split("\n")), () => now);
    const drainAt = (time: number) => { now = time; timers.splice(0).forEach(callback => callback()); };
    pacer.push([{ type: "down", x: 0.5, y: 0.5, dt: 0 }]);
    assert.deepEqual(lines, ["t d 0.50000 0.50000"]);
    // A batch that arrives 40 ms late keeps its 16 ms spacing.
    now = 1040;
    pacer.push([{ type: "move", x: 0.5, y: 0.4, dt: 16 }, { type: "move", x: 0.5, y: 0.3, dt: 16 }, { type: "up", x: 0.5, y: 0.3, dt: 16 }]);
    assert.equal(lines.length, 2);
    drainAt(1056);
    assert.equal(lines.length, 3);
    drainAt(1072);
    assert.deepEqual(lines.slice(3), ["t u 0.50000 0.30000"]);
    // A batch spanning far longer than the lag bound compresses into it.
    now = 5000;
    pacer.push(Array.from({ length: 10 }, (_, index) => ({ type: "move" as const, x: index / 10, y: 0.5, dt: 100 })));
    drainAt(5050);
    assert.equal(lines.length, 14);
    assert.equal(timers.length, 0);
    pacer.close();
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test("session and hub shutdown end pending MCP reads and release every relay", async t => {
  const f = fixture(t, singleFrame);
  const first = await f.video.stream("session-one", "simulator-one");
  const second = await f.video.stream("session-two", "simulator-two");
  const batches = await Promise.all([f.video.read("session-one", first.streamId!), f.video.read("session-two", second.streamId!)]);
  assert.ok(batches.every(batch => batch.frames.length === 1));
  const firstRead = assert.rejects(f.video.read("session-one", first.streamId!), /stream stopped/);
  const unaffected = f.video.read("session-two", second.streamId!);
  const firstExit = deadline(once(f.children[0]!, "exit"));
  f.video.closeSession("session-one");
  await Promise.all([firstRead, firstExit]);
  assert.deepEqual((await unaffected).frames, [], "another session's read completes normally");
  const secondRead = assert.rejects(f.video.read("session-two", second.streamId!), /stream stopped/);
  const secondExit = deadline(once(f.children[1]!, "exit"));
  await f.video.close();
  await Promise.all([secondRead, secondExit]);
  assert.equal((Reflect.get(f.video, "relays") as Map<string, unknown>).size, 0);
});

test("Apple interaction disconnect closes live video before ending the native session", async t => {
  const f = fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "apple-video-test-"));
  const screenshotPath = join(directory, "native.png");
  const hierarchyPath = join(directory, "native.txt");
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(390, 16);
  png.writeUInt32BE(844, 20);
  await writeFile(screenshotPath, png);
  await writeFile(hierarchyPath, "Window, {{0, 0}, {390, 844}}");
  let ended = false;
  let capabilityToRevoke: string | undefined;
  const boundary: AppleBoundary = {
    async command(args) {
      if (args[0] === "simctl") return JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-2": [{ udid: "simulator-one", name: "iPhone", state: "Booted", isAvailable: true }] } });
      if (args.includes("--json-output")) await writeFile(args[args.indexOf("--json-output") + 1]!, JSON.stringify({ result: { devices: [] } }));
      return "";
    },
    async tool(name) {
      if (name === "DeviceInteractionStartSession") return { structuredContent: { interactionSessionKey: "private-native-key" } };
      if (name === "DeviceInteractionSynthesize") return { structuredContent: { screenshotPath, hierarchyPath } };
      if (name === "DeviceInteractionEndSession") {
        assert.equal(f.children[0]!.killed, true, "video capture is stopped before the native interaction session ends");
        assert.ok(capabilityToRevoke);
        assert.equal(await rejected(capabilityToRevoke), 403, "unclaimed viewers are revoked before the native interaction session ends");
        ended = true;
      }
      return { structuredContent: {} };
    },
    async close() {},
  };
  const hub = new AppleHub({ boundary, video: f.video });
  t.after(async () => { await hub.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(hub.stream("unknown-session"), /expired or disconnected/);
  assert.equal(f.children.length, 0);
  const session = await hub.connect("simulator-one");
  const view = await viewer(t, (await hub.stream(session.id)).url);
  await view.firstFrame;
  const unused = await hub.stream(session.id);
  capabilityToRevoke = unused.url;
  const closed = deadline(once(view.socket, "close"));
  const exited = deadline(once(f.children[0]!, "exit"));
  await hub.disconnect(session.id);
  assert.equal(ended, true);
  await Promise.all([closed, exited]);
  assert.equal(await rejected(unused.url), 403);
  await assert.rejects(hub.stream(session.id), /expired or disconnected/);
});
