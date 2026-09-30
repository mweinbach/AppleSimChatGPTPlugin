import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { coordinateSpaceMatchesFrame, inspectH264AccessUnit, SimulatorVideoPlayer } from "../src/video-player.js";

const keyframe = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 0xcc]);
const delta = new Uint8Array([0, 0, 1, 0x41, 0xcc]);

test("Annex B inspection reads mixed start codes and the actual SPS codec", () => {
  assert.deepEqual(inspectH264AccessUnit(keyframe), { keyFrame: true, hasPicture: true, hasParameterSets: true, codec: "avc1.42E01F" });
  assert.deepEqual(inspectH264AccessUnit(delta), { keyFrame: false, hasPicture: true, hasParameterSets: false, codec: undefined });
  assert.equal(inspectH264AccessUnit(new Uint8Array([0, 0, 1, 0x09, 0xf0])).hasPicture, false);
});

test("touch mapping accepts scaled frames and rejects the preceding rotation", () => {
  assert.equal(coordinateSpaceMatchesFrame({ width: 440, height: 956 }, { width: 1320, height: 2868 }), true);
  assert.equal(coordinateSpaceMatchesFrame({ width: 440, height: 956 }, { width: 2868, height: 1320 }), false);
  assert.equal(coordinateSpaceMatchesFrame({ width: 0, height: 956 }, { width: 1320, height: 2868 }), false);
});

function fakeBrowser(run: (browser: { decoder: () => FakeDecoder; socket: () => FakeSocket; canvas: HTMLCanvasElement; draws: unknown[]; decoders: FakeDecoder[]; sockets: FakeSocket[]; timers: Map<number, { callback: () => void; delay: number }> }) => void | Promise<void>, options: { socketError?: Error; decodeInTasks?: boolean } = {}): void | Promise<void> {
  let decoder: FakeDecoder;
  let socket: FakeSocket;
  const draws: unknown[] = [];
  const decoders: FakeDecoder[] = [];
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  class BrowserDecoder extends FakeDecoder {
    constructor(callbacks: VideoDecoderInit) { super(callbacks); decoder = this; decoders.push(this); }
    override decode(chunk: { init: EncodedVideoChunkInit }) {
      super.decode(chunk);
      if (options.decodeInTasks) {
        this.decodeQueueSize++;
        setImmediate(() => {
          if (this.state === "closed") return;
          this.decodeQueueSize--;
          this.dispatchEvent(new Event("dequeue"));
          this.callbacks.output({ displayWidth: 440, displayHeight: 956, close() {} } as unknown as VideoFrame);
        });
      }
    }
  }
  class BrowserSocket extends FakeSocket {
    constructor(url: string) { super(url); if (options.socketError) throw options.socketError; socket = this; sockets.push(this); }
  }
  class BrowserChunk {
    constructor(readonly init: EncodedVideoChunkInit) {}
  }
  const globals = globalThis as unknown as Record<string, unknown>;
  const replacements = {
    VideoDecoder: BrowserDecoder, EncodedVideoChunk: BrowserChunk, WebSocket: BrowserSocket,
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  const previous = Object.keys(replacements).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globals, name, { value, configurable: true, writable: true });
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (frame: unknown) => { draws.push(frame); } }) } as unknown as HTMLCanvasElement;
  const restore = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    }
  };
  try {
    const result = run({ decoder: () => decoder!, socket: () => socket!, canvas, draws, decoders, sockets, timers });
    if (result) return result.finally(restore);
    restore();
  } catch (error) { restore(); throw error; }
}

class FakeDecoder extends EventTarget {
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  configs: VideoDecoderConfig[] = [];
  chunks: { init: EncodedVideoChunkInit }[] = [];
  resets = 0;
  constructor(readonly callbacks: VideoDecoderInit) { super(); }
  configure(config: VideoDecoderConfig) { this.configs.push(config); this.state = "configured"; }
  decode(chunk: { init: EncodedVideoChunkInit }) { this.chunks.push(chunk); }
  reset() { this.resets++; this.decodeQueueSize = 0; this.state = "unconfigured"; }
  close() { this.state = "closed"; }
}

class FakeSocket {
  binaryType = "";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closes = 0;
  constructor(readonly url: string) {}
  close() { this.closes++; }
  sendFrame(data: Uint8Array) { this.onmessage?.({ data: data.slice().buffer } as MessageEvent); }
}

test("video waits for a complete IDR, catches up after backpressure, and releases every frame on teardown", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const dimensions: unknown[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.42E01F", fps: 30 }, size => dimensions.push(size), error => errors.push(error));
    try {
      player.start();
      const decoder = browser.decoder();
      const socket = browser.socket();
      assert.equal(socket.binaryType, "arraybuffer");
      assert.equal(decoder.configs.length, 0);
      socket.sendFrame(delta);
      socket.sendFrame(new Uint8Array([0, 0, 1, 0x65, 0xcc]));
      assert.equal(decoder.chunks.length, 0);
      socket.sendFrame(keyframe);
      assert.equal(decoder.configs[0].description, undefined);
      socket.sendFrame(delta);
      assert.deepEqual(decoder.chunks.map(chunk => chunk.init.type), ["key", "delta"]);
      assert.deepEqual(decoder.chunks.map(chunk => chunk.init.timestamp), [0, 33333]);
      decoder.decodeQueueSize = 5;
      socket.sendFrame(delta);
      socket.sendFrame(delta);
      assert.equal(decoder.resets, 1);
      assert.equal(decoder.chunks.length, 2);
      socket.sendFrame(keyframe);
      assert.equal(decoder.chunks.length, 3);
      let closes = 0;
      const frame = { displayWidth: 1320, displayHeight: 2868, close: () => { closes++; } } as unknown as VideoFrame;
      decoder.callbacks.output(frame);
      assert.equal(closes, 1);
      assert.deepEqual(dimensions, [{ width: 1320, height: 2868 }]);
      assert.equal(browser.draws.length, 1);
      assert.equal(browser.canvas.width, 1320);
      player.stop();
      decoder.callbacks.output(frame);
      assert.equal(closes, 2);
      assert.equal(browser.draws.length, 1);
      assert.equal(decoder.state, "closed");
      assert.equal(socket.closes, 1);
      assert.equal(socket.onmessage, null);
      assert.deepEqual(errors, []);
    } finally { player.stop(); }
  });
});

test("startup uses the actual SPS codec and does not duplicate or resurrect transports", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.64001F", fps: 30 }, () => {}, error => errors.push(error));
    try {
      player.start();
      player.start();
      assert.equal(browser.decoders.length, 1);
      assert.equal(browser.sockets.length, 1);
      assert.equal(browser.decoder().configs.length, 0);
      browser.socket().sendFrame(keyframe);
      assert.equal(browser.decoder().configs[0].codec, "avc1.42E01F");
      player.stop();
      player.start();
      assert.equal(browser.decoders.length, 1);
      assert.equal(browser.sockets.length, 1);
      assert.equal(browser.timers.size, 0);
      assert.deepEqual(errors, []);
    } finally { player.stop(); }
  });
});

test("HEVC decoding waits for VPS, SPS and PPS, then configures from the actual SPS", () => {
  fakeBrowser(browser => {
    const unit = new Uint8Array([0, 0, 1, 0x40, 1, 0xaa, 0, 0, 1, 0x42, 1, 1, 1, 0x60, 0, 0, 3, 0, 0xb0, 0, 0, 3, 0, 0, 3, 0, 0x96, 0, 0, 1, 0x44, 1, 0xbb, 0, 0, 1, 0x26, 1, 0xcc]);
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", format: "hevc", url: "ws://127.0.0.1:1234/video/token", codec: "hev1.1.6.L120.B0", fps: 30 }, () => {}, error => assert.fail(error.message));
    try {
      player.start();
      browser.socket().sendFrame(unit.subarray(6));
      assert.equal(browser.decoder().chunks.length, 0);
      browser.socket().sendFrame(unit);
      assert.equal(browser.decoder().configs[0]!.codec, "hev1.1.6.L150.B0");
      assert.equal(browser.decoder().configs[0]!.description, undefined, "in-band parameter sets use Annex B decoding");
      assert.equal(browser.decoder().chunks[0]!.init.type, "key");
      browser.socket().sendFrame(new Uint8Array([0, 0, 1, 2, 1, 0xcc]));
      assert.equal(browser.decoder().chunks[1]!.init.type, "delta");
    } finally { player.stop(); }
  });
});

test("a synchronous transport failure closes the decoder and reports once", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "invalid", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error));
    player.start();
    player.start();
    assert.equal(browser.decoder().state, "closed");
    assert.equal(browser.decoders.length, 1);
    assert.equal(browser.sockets.length, 0);
    assert.equal(browser.timers.size, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Invalid WebSocket URL.");
  }, { socketError: new Error("Invalid WebSocket URL.") });
});

test("decoder configuration failures release the capture transport", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error));
    try {
      player.start();
      browser.decoder().configure = () => { throw new Error("Unsupported H.264 configuration."); };
      browser.socket().sendFrame(keyframe);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, "Unsupported H.264 configuration.");
      assert.equal(browser.socket().closes, 1);
      assert.equal(browser.decoder().state, "closed");
      assert.equal(browser.timers.size, 0);
    } finally { player.stop(); }
  });
});

test("stopping from the rendered-frame callback leaves no watchdog behind", () => {
  fakeBrowser(browser => {
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.42E01F", fps: 30 }, () => player.stop(), error => assert.fail(error.message));
    player.start();
    let closes = 0;
    browser.decoder().callbacks.output({ displayWidth: 440, displayHeight: 956, close: () => { closes++; } } as unknown as VideoFrame);
    assert.equal(closes, 1);
    assert.equal(browser.timers.size, 0);
    assert.equal(browser.socket().closes, 1);
  });
});

test("startup permits native error reporting while decoded-frame stalls fail promptly", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error));
    try {
      player.start();
      assert.equal([...browser.timers.values()][0].delay, 20_000);
      browser.decoder().callbacks.output({ displayWidth: 440, displayHeight: 956, close: () => {} } as unknown as VideoFrame);
      assert.equal(browser.timers.size, 1);
      const watchdog = [...browser.timers.values()][0];
      assert.equal(watchdog.delay, 5000);
      watchdog.callback();
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, "The simulator stopped producing live video frames.");
      assert.equal(browser.socket().closes, 1);
      assert.equal(browser.timers.size, 0);
    } finally { player.stop(); }
  });
});

test("a native capture error closes the transport and reports one actionable failure", () => {
  fakeBrowser(browser => {
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", url: "ws://127.0.0.1:1234/video/token", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error));
    try {
      player.start();
      const socket = browser.socket();
      const receive = socket.onmessage!;
      receive({ data: JSON.stringify({ type: "error", message: "Simulator display unavailable." }) } as MessageEvent);
      receive({ data: JSON.stringify({ type: "error", message: "Repeated failure." }) } as MessageEvent);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, "Simulator display unavailable.");
      assert.equal(socket.closes, 1);
      assert.equal(browser.decoder().state, "closed");
    } finally { player.stop(); }
  });
});

test("MCP transport keeps one read in flight and discards late batches after stopping", async () => {
  await fakeBrowser(async browser => {
    const reads: Array<(frames: Uint8Array[]) => void> = [];
    let stops = 0;
    let activeReads = 0;
    let maximumReads = 0;
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", streamId: "token", url: "ws://blocked", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error), {
      read() {
        activeReads++;
        maximumReads = Math.max(maximumReads, activeReads);
        return new Promise<Uint8Array[]>(resolve => { reads.push(resolve); }).finally(() => { activeReads--; });
      },
      stop() { stops++; },
    });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    try {
      player.start();
      assert.equal(reads.length, 1);
      assert.equal(browser.sockets.length, 0, "embedded transport never opens a blocked WebSocket");
      reads.shift()!([delta, keyframe, delta]);
      await flush();
      assert.deepEqual(browser.decoder().chunks.map(chunk => chunk.init.type), ["key", "delta"]);
      assert.equal(reads.length, 1);
      assert.equal(maximumReads, 1);
      browser.decoder().decodeQueueSize = 6;
      reads.shift()!([delta]);
      await flush();
      assert.equal(browser.decoder().resets, 0, "ordinary batch decoding does not discard its GOP");
      assert.equal(reads.length, 0, "the next batch waits for decoder backpressure to clear");
      browser.decoder().decodeQueueSize = 0;
      browser.decoder().dispatchEvent(new Event("dequeue"));
      await flush();
      player.stop();
      const chunks = browser.decoder().chunks.length;
      reads.shift()!([keyframe]);
      await flush();
      assert.equal(browser.decoder().chunks.length, chunks);
      assert.equal(browser.decoder().state, "closed");
      assert.equal(reads.length, 0);
      assert.equal(stops, 1);
      assert.equal(browser.timers.size, 0);
      assert.deepEqual(errors, []);
    } finally { player.stop(); }
  });
});

test("native MCP capture errors close the relay and report once", async () => {
  await fakeBrowser(async browser => {
    let rejectRead: (error: Error) => void;
    let stops = 0;
    const errors: Error[] = [];
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", streamId: "token", url: "ws://blocked", codec: "avc1.42E01F", fps: 30 }, () => {}, error => errors.push(error), {
      read: () => new Promise<Uint8Array[]>((_resolve, reject) => { rejectRead = reject; }),
      stop() { stops++; },
    });
    try {
      player.start();
      rejectRead!(new Error("Simulator display unavailable."));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(stops, 1);
      assert.equal(browser.decoder().state, "closed");
      assert.equal(browser.timers.size, 0);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, "Simulator display unavailable.");
      assert.equal(browser.sockets.length, 0);
    } finally { player.stop(); }
  });
});

test("a full relay batch renders without resetting the queued keyframe", async () => {
  await fakeBrowser(async browser => {
    const reads: Array<(frames: Uint8Array[]) => void> = [];
    let stops = 0;
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", streamId: "token", url: "ws://blocked", codec: "avc1.42E01F", fps: 30 }, () => {}, error => assert.fail(error.message), {
      read: () => new Promise<Uint8Array[]>(resolve => { reads.push(resolve); }),
      stop() { stops++; },
    });
    try {
      player.start();
      reads.shift()!([keyframe, ...Array.from({ length: 29 }, () => delta)]);
      for (let tick = 0; tick < 40 && browser.draws.length < 30; tick++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(browser.draws.length, 30);
      assert.equal(browser.decoder().chunks.length, 30);
      assert.equal(browser.decoder().resets, 0);
      assert.equal(reads.length, 1, "the next bounded batch is requested after decoding");
      assert.equal(getEventListeners(browser.decoder(), "dequeue").length, 0);
      player.stop();
      reads.shift()!([]);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(stops, 1);
    } finally { player.stop(); }
  }, { decodeInTasks: true });
});

test("stopping a relay while the decoder is full releases its dequeue waiter", async () => {
  await fakeBrowser(async browser => {
    const reads: Array<(frames: Uint8Array[]) => void> = [];
    let stops = 0;
    const player = new SimulatorVideoPlayer(browser.canvas, { sessionId: "session", streamId: "token", url: "ws://blocked", codec: "avc1.42E01F", fps: 30 }, () => {}, error => assert.fail(error.message), {
      read: () => new Promise<Uint8Array[]>(resolve => { reads.push(resolve); }),
      stop() { stops++; },
    });
    player.start();
    const decoder = browser.decoder();
    const decode = decoder.decode.bind(decoder);
    decoder.decode = chunk => { decode(chunk); decoder.decodeQueueSize++; };
    reads.shift()!([keyframe, ...Array.from({ length: 29 }, () => delta)]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(decoder.chunks.length, 4);
    assert.equal(getEventListeners(decoder, "dequeue").length, 1);
    player.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(decoder.chunks.length, 4);
    assert.equal(getEventListeners(decoder, "dequeue").length, 0);
    assert.equal(reads.length, 0);
    assert.equal(stops, 1);
    assert.equal(browser.timers.size, 0);
  });
});
