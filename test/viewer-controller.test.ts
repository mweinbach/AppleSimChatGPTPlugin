import assert from "node:assert/strict";
import test from "node:test";
import { App } from "@modelcontextprotocol/ext-apps";
import type { CaptureState, Session } from "../src/shared.js";

class ViewerNode extends EventTarget {
  hidden = true;
  width = 0;
  height = 0;
  src = "";
  alt = "";
  style = { left: "", top: "", colorScheme: "", setProperty() {} };
  setAttribute() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  getContext() { return { drawImage() {} }; }
}

class ViewerDecoder {
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  chunks: Array<{ init: EncodedVideoChunkInit }> = [];
  constructor(readonly callbacks: VideoDecoderInit) {}
  configure() { this.state = "configured"; }
  reset() { this.state = "unconfigured"; }
  decode(chunk: { init: EncodedVideoChunkInit }) { this.chunks.push(chunk); }
  close() { this.state = "closed"; }
}

class ViewerSocket {
  binaryType = "";
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closes = 0;
  close() { this.closes++; }
}

const current: Session = {
  id: "session",
  device: { id: "simulator", name: "Test Simulator", kind: "simulator", platform: "iOS", runtime: "iOS 27", state: "Booted", available: true },
  accessibilityEnabled: false,
};

function captured(data: string) {
  const capture: CaptureState = {
    session: current,
    capturedAt: "2026-09-30T12:00:00.000Z",
    coordinateSpace: { width: 440, height: 956 },
    screenshot: { mimeType: "image/png", width: 440, height: 956 },
  };
  return { content: [{ type: "image", data, mimeType: "image/png" }], structuredContent: capture };
}

for (const mode of ["websocket", "relay-preview", "relay-host", "hevc-capture-failure", "hevc-decoder-failure", "hevc-preflight"] as const) test(`${mode} viewer ignores obsolete starts, exposes fresh stills on failure, and resumes video after Retry`, async t => {
  const hevc = mode.startsWith("hevc");
  const relay = mode === "relay-preview" || mode === "relay-host";
  const host = mode === "relay-host";
  const documentTarget = new EventTarget();
  const document = Object.assign(documentTarget, { hidden: false, documentElement: new ViewerNode() });
  const window = Object.assign(new EventTarget(), { __APPLE_DEVICE_HUB_PREVIEW__: !host, location: { search: relay ? "?transport=mcp" : "" } });
  const screen = new ViewerNode();
  const canvas = new ViewerNode();
  const frame = new ViewerNode();
  const root = new ViewerNode();
  const gesture = new ViewerNode();
  const sockets: ViewerSocket[] = [];
  const decoders: ViewerDecoder[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const streams: Array<(result: unknown) => void> = [];
  const requestedCodecs: string[] = [];
  const probes: Array<(result: VideoDecoderSupport) => void> = [];
  const reads: Array<{ streamId: string; resolve: (result: unknown) => void }> = [];
  const stops: string[] = [];
  const attachments: unknown[] = [];
  const calls: string[] = [];
  let timerId = 0;
  let frameNumber = 0;
  let streamNumber = 0;
  class BrowserSocket extends ViewerSocket {
    constructor() { super(); sockets.push(this); }
  }
  class BrowserDecoder extends ViewerDecoder {
    static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
      if (mode === "hevc-preflight") return new Promise(resolve => { probes.push(resolve); });
      return { supported: hevc, config };
    }
    constructor(callbacks: VideoDecoderInit) { super(callbacks); decoders.push(this); }
  }
  const tool = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === "device_hub_status") return { content: [], structuredContent: { devices: [current.device], sessions: [current], warnings: [] } };
    if (name === "device_stream") { requestedCodecs.push(args.codec as string); return new Promise(resolve => { streams.push(resolve); }); }
    if (name === "device_stream_read") return new Promise(resolve => { reads.push({ streamId: args.streamId as string, resolve }); });
    if (name === "device_stream_stop") { stops.push(args.streamId as string); return { content: [], structuredContent: { stopped: true } }; }
    if (name === "device_capture") return captured("initial-still");
    if (name === "device_action") return captured("action-still");
    if (name === "device_frame") return captured(`fallback-${++frameNumber}`);
    throw new Error(`Unexpected tool ${name}`);
  };
  if (host) {
    t.mock.method(App.prototype, "connect", async () => {});
    t.mock.method(App.prototype, "callServerTool", async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => tool(name, args));
    t.mock.method(App.prototype, "getHostCapabilities", () => ({ updateModelContext: { image: {} } }));
    t.mock.method(App.prototype, "getHostContext", () => ({ theme: "light" }));
    t.mock.method(App.prototype, "updateModelContext", async (payload: unknown) => { attachments.push(payload); return {}; });
  }
  const replacements = {
    document, window,
    matchMedia: () => ({ matches: false }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    VideoDecoder: BrowserDecoder, WebSocket: BrowserSocket,
    EncodedVideoChunk: class { constructor(readonly init: EncodedVideoChunkInit) {} },
    Image: class { src = ""; async decode() {} },
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    fetch: async (_url: string, init: RequestInit) => {
      const { name, arguments: args } = JSON.parse(init.body as string) as { name: string; arguments: Record<string, unknown> };
      const result = await tool(name, args);
      return { ok: true, async json() { return result; } };
    },
  };
  const previous = Object.keys(replacements).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
  const openStream = async () => {
    if (mode === "hevc-preflight") { probes.shift()?.({ supported: false }); }
    await flush();
    const resolve = streams.shift();
    assert.ok(resolve, "a stream descriptor was requested");
    const streamId = (++streamNumber).toString(16).padStart(48, "0");
    const format = requestedCodecs.at(-1);
    resolve({ content: [], structuredContent: { sessionId: current.id, streamId, url: "ws://127.0.0.1:1234/video/token", format, codec: format === "hevc" ? "hev1.1.6.L150.B0" : "avc1.42E01F", fps: 30 } });
    await flush();
    return streamId;
  };
  const deliverBatch = async (sessionId = current.id) => {
    const read = reads.shift();
    assert.ok(read, "one relay read is awaiting its next batch");
    read.resolve({ content: [{ type: "text", text: "Simulator video batch." }], _meta: { "apple-device-hub/video": { sessionId, streamId: read.streamId, active: true, frames: [Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 0xcc]).toString("base64")] } } });
    await flush();
  };
  const failStream = async () => {
    if (relay) {
      const read = reads.shift();
      assert.ok(read);
      read.resolve({ isError: true, content: [{ type: "text", text: "Simulator display unavailable." }] });
    } else sockets.at(-1)!.onerror!();
    await flush();
  };
  const fireTimer = (delay: number) => {
    const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(timer, `a ${delay}ms timer was scheduled`);
    timers.delete(timer[0]);
    timer[1].callback();
  };
  try {
    const module = new URL("../src/viewer-controller.ts", import.meta.url);
    module.searchParams.set("test", mode);
    const viewer = await import(module.href) as typeof import("../src/viewer-controller.js");
    await viewer.initializeViewer({ root: root as unknown as HTMLElement, screen: screen as unknown as HTMLImageElement, canvas: canvas as unknown as HTMLCanvasElement, frame: frame as unknown as HTMLElement, gesture: gesture as unknown as HTMLElement });
    if (host) await viewer.scanDevices();
    if (mode === "hevc-preflight") {
      assert.equal(streams.length, 0);
      document.hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      probes.shift()!({ supported: true });
      await flush();
      assert.equal(requestedCodecs.length, 0, "a late capability result cannot create a hidden viewer's stream");
      document.hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      probes.shift()!({ supported: false });
      await flush();
    }
    assert.equal(viewer.getSnapshot().noticeError, false);
    assert.equal(streams.length, 1);
    assert.equal(screen.src, "data:image/png;base64,initial-still");

    // A descriptor that arrives after the viewer hides must never open a socket.
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    const obsoleteId = await openStream();
    assert.equal(sockets.length, 0);
    assert.ok(stops.includes(obsoleteId), "obsolete descriptors are released by their own stream ID");
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await openStream();
    assert.equal(sockets.length, relay ? 0 : 1);
    if (hevc && mode !== "hevc-preflight") {
      assert.equal(requestedCodecs.at(-1), "hevc");
      if (mode === "hevc-decoder-failure") decoders.at(-1)!.callbacks.error(new DOMException("HEVC decoding unavailable."));
      else await failStream();
      await flush();
      assert.match(viewer.getSnapshot().videoMessage, /Switching to H.264/);
      assert.equal(canvas.hidden, true);
      assert.equal(frame.hidden, false);
      fireTimer(0);
      await openStream();
      assert.equal(requestedCodecs.at(-1), "h264");
    } else assert.ok(requestedCodecs.every(codec => codec === "h264"));
    if (relay) {
      await deliverBatch();
      assert.equal(decoders.at(-1)!.chunks.length, 1, "the player consumes H.264 from tool metadata");
    }
    decoders.at(-1)!.callbacks.output({ displayWidth: 440, displayHeight: 956, close() {} } as unknown as VideoFrame);
    assert.equal(viewer.getSnapshot().videoReady, true);
    assert.equal(canvas.hidden, false);

    if (host) {
      assert.equal(viewer.getSnapshot().contextEnabled, true);
      await viewer.attachScreen();
      assert.equal(attachments.length, 1, "standard model context remains supported without experimental extensions");
    }
    if (relay) await deliverBatch("another-session");
    else await failStream();
    assert.equal(viewer.getSnapshot().videoReady, false);
    assert.equal(canvas.hidden, true);
    assert.equal(frame.hidden, false);
    await viewer.performAction({ type: "button", button: "home" });
    assert.equal(screen.src, "data:image/png;base64,action-still");
    assert.equal(canvas.hidden, true);

    // Retry delays grow, then still-frame polling takes over after four failures.
    for (const delay of [500, 1000, 2000]) {
      fireTimer(delay);
      await openStream();
      await failStream();
    }
    assert.equal(viewer.getSnapshot().videoError, true);
    fireTimer(60);
    await flush();
    assert.ok(calls.includes("device_frame"));
    assert.equal(screen.src, "data:image/png;base64,fallback-1");
    assert.equal(canvas.hidden, true);

    viewer.setLive(false);
    assert.equal(timers.size, 0, "paused fallback does not poll or reconnect");
    viewer.setLive(true);
    await openStream();
    if (relay) await deliverBatch();
    decoders.at(-1)!.callbacks.output({ displayWidth: 440, displayHeight: 956, close() {} } as unknown as VideoFrame);
    assert.equal(viewer.getSnapshot().videoReady, true);
    assert.equal(canvas.hidden, false);
    assert.equal(viewer.getSnapshot().videoError, false);

    viewer.retryVideo();
    assert.equal(canvas.hidden, true);
    if (relay) {
      const oldDecoder = decoders.at(-1)!;
      const chunks = oldDecoder.chunks.length;
      await deliverBatch();
      assert.equal(oldDecoder.chunks.length, chunks, "a stopped relay cannot render a late batch");
    }
    await openStream();
    if (hevc && mode !== "hevc-preflight") assert.equal(requestedCodecs.at(-1), "hevc", "explicit Retry permits a fresh HEVC attempt");
    if (relay) await deliverBatch();
    decoders.at(-1)!.callbacks.output({ displayWidth: 440, displayHeight: 956, close() {} } as unknown as VideoFrame);
    assert.equal(viewer.getSnapshot().videoReady, true);
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(viewer.getSnapshot().ended, true);
    assert.equal(timers.size, 0);
    assert.ok(sockets.every(socket => socket.closes === 1));
    assert.ok(decoders.every(decoder => decoder.state === "closed"));
    if (relay) assert.equal(stops.length, streamNumber, "every relay is stopped exactly once");
  } finally {
    window.dispatchEvent(new Event("pagehide"));
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[name];
    }
  }
});
