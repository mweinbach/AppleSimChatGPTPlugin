import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callHubTool, captureResult, createHubServer, HIERARCHY_META_KEY, UI_URI, type Hub } from "../src/mcp.js";
import type { Capture, Session } from "../src/shared.js";
import { SessionExpiredError } from "../src/apple.js";

const session: Session = { id: "16764887-9da3-43ed-85d4-a372838d5a70", device: { id: "simulator-one", name: "Test iPhone", kind: "simulator", platform: "iOS", runtime: "iOS 27", state: "Booted", available: true }, accessibilityEnabled: true };
function frame(enabled = true): Capture {
  return { session: { ...session, accessibilityEnabled: enabled }, capturedAt: "2026-09-23T10:00:00.000Z", screenshot: { mimeType: "image/png", data: "screen-base64", width: 1170, height: 2532 }, coordinateSpace: { width: 390, height: 844 }, ...(enabled ? { hierarchy: "Window {{0, 0}, {390, 844}}" } : {}) };
}
function fakeHub(): { hub: Hub; calls: unknown[] } {
  const calls: unknown[] = [];
  const hub: Hub = {
    async status() { return { devices: [session.device], sessions: [], warnings: [] }; },
    async connect(id) { calls.push(["connect", id]); return session; },
    async capture(id, options) { calls.push(["capture", id, options]); return frame(options?.accessibilityEnabled ?? true); },
    async frame(id) { calls.push(["frame", id]); return { ...frame(false), screenshot: { mimeType: "image/jpeg", data: "frame-base64", width: 644, height: 1400 } }; },
    async stream(id, format = "h264", maxDimension) { calls.push(["stream", id, format, ...(maxDimension ? [maxDimension] : [])]); return { sessionId: id, url: "ws://127.0.0.1:5555/video/test", format, codec: format === "hevc" ? "hev1.1.6.L150.B0" : "avc1.42E01F", fps: 60 }; },
    async streamRead(id, streamId) { calls.push(["streamRead", id, streamId]); return { sessionId: id, streamId, sequence: 0, frames: ["encoded-video-frame"], active: true }; },
    async streamStop(id, streamId) { calls.push(["streamStop", id, streamId]); },
    async input(id, events) { calls.push(["input", id, events]); },
    async action(id, action, options) { calls.push(["action", id, action, options]); return frame(); },
    async settings(id, settings) { calls.push(["settings", id, settings]); return frame(); },
    async disconnect(id) { calls.push(["disconnect", id]); },
    async close() {},
  };
  return { hub, calls };
}

test("capture exposes one image and logical points without putting image bytes into structured state", () => {
  const result = captureResult(frame());
  assert.equal(result.content.filter(item => item.type === "image").length, 1);
  assert.equal(JSON.stringify(result.structuredContent).includes("screen-base64"), false);
  assert.deepEqual(result.structuredContent?.coordinateSpace, { width: 390, height: 844 });
});

test("video requests validate and route HEVC while older requests retain H.264", async () => {
  const { hub, calls } = fakeHub();
  assert.equal((await callHubTool(hub, "device_stream", { sessionId: session.id, codec: "hevc" })).structuredContent?.format, "hevc");
  assert.equal((await callHubTool(hub, "device_stream", { sessionId: session.id })).structuredContent?.format, "h264");
  assert.equal((await callHubTool(hub, "device_stream", { sessionId: session.id, codec: "unknown" })).isError, true);
  await callHubTool(hub, "device_stream", { sessionId: session.id, codec: "hevc", maxDimension: 1600 });
  assert.equal((await callHubTool(hub, "device_stream", { sessionId: session.id, maxDimension: 12 })).isError, true);
  assert.deepEqual(calls, [["stream", session.id, "hevc"], ["stream", session.id, "h264"], ["stream", session.id, "hevc", 1600]]);
});

test("live input accepts bounded touch and Home events in frame fractions only", async () => {
  const { hub, calls } = fakeHub();
  const events = [{ type: "down", x: 0.25, y: 0.5 }, { type: "move", x: 0.3, y: 0.5, dt: 16 }, { type: "up", x: 0.3, y: 0.5, dt: 16 }, { type: "home" }];
  assert.deepEqual((await callHubTool(hub, "device_input", { sessionId: session.id, events })).structuredContent, { delivered: 4 });
  assert.deepEqual(calls, [["input", session.id, events.map(event => ({ dt: 0, ...event }))]]);
  calls.length = 0;
  for (const invalid of [[], [{ type: "down", x: 1.5, y: 0.5 }], [{ type: "move", x: 0.5 }], [{ type: "home", dt: 5000 }], [{ type: "shell", command: "ls" }], Array.from({ length: 65 }, () => ({ type: "home" }))]) {
    assert.equal((await callHubTool(hub, "device_input", { sessionId: session.id, events: invalid })).isError, true);
  }
  assert.deepEqual(calls, []);
});

test("model text lists elements while the raw hierarchy travels only in _meta for the viewer", () => {
  const capture: Capture = { ...frame(), screenshot: { mimeType: "image/jpeg", data: "x", width: 390, height: 844 }, bundleId: "com.apple.Preferences", snapshot: 4,
    elements: [{ ref: "e1", role: "Button", label: "General", identifier: "com.apple.settings.general", frame: { x: 16, y: 380, width: 370, height: 52 }, point: { x: 201, y: 406.3 } }] };
  const result = captureResult(capture);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /App: com\.apple\.Preferences/);
  assert.match(text, /image is a tap coordinate/);
  assert.match(text, /\[e1\] Button "General" id="com\.apple\.settings\.general" @ 201,406\.3/);
  assert.equal(text.includes("Window {{"), false);
  assert.equal(result.structuredContent?.hierarchy, undefined);
  assert.equal(JSON.stringify(result.structuredContent).includes("General"), false);
  assert.equal(result._meta?.[HIERARCHY_META_KEY], capture.hierarchy);
  assert.match((captureResult(frame()).content[0] as { text: string }).text, /scale positions/);
  assert.match((captureResult(frame(false)).content[0] as { text: string }).text, /elements are hidden/);
});

test("actions pass settle and resolution through and default to agent behaviour", async () => {
  const { hub, calls } = fakeHub();
  await callHubTool(hub, "device_action", { sessionId: session.id, action: { type: "tap", element: { ref: "e3" } } });
  await callHubTool(hub, "device_action", { sessionId: session.id, action: { type: "scroll", direction: "down" }, settle: false, resolution: "full" });
  assert.deepEqual(calls, [
    ["action", session.id, { type: "tap", element: { ref: "e3" } }, {}],
    ["action", session.id, { type: "scroll", direction: "down", distance: 0.6 }, { settle: false, resolution: "full" }],
  ]);
  assert.equal((await callHubTool(hub, "device_action", { sessionId: session.id, action: { type: "tap", element: { ref: "button-3" } } })).isError, true);
  assert.equal((await callHubTool(hub, "device_action", { sessionId: session.id, action: { type: "launchApp", bundleId: "com.apple.x; rm -rf" } })).isError, true);
});

test("disabling the hierarchy passes the view preference through and omits tree data from the result", async () => {
  const { hub, calls } = fakeHub();
  const result = await callHubTool(hub, "device_capture", { sessionId: session.id, accessibilityEnabled: false });
  assert.deepEqual(calls, [["capture", session.id, { accessibilityEnabled: false }]]);
  assert.equal(result.structuredContent?.hierarchy, undefined);
  assert.equal(JSON.stringify(result.content).includes("Window"), false);
});

test("live frames return a compressed image without hierarchy", async () => {
  const { hub, calls } = fakeHub();
  const result = await callHubTool(hub, "device_frame", { sessionId: session.id });
  assert.deepEqual(calls, [["frame", session.id]]);
  assert.deepEqual(result.content.find(item => item.type === "image"), { type: "image", data: "frame-base64", mimeType: "image/jpeg" });
  assert.equal(result.structuredContent?.hierarchy, undefined);
  assert.equal((await callHubTool(hub, "device_frame", { sessionId: "not-a-session" })).isError, true);
});

test("embedded native video batches stay in app metadata and stop is scoped", async () => {
  const { hub, calls } = fakeHub();
  const streamId = "a".repeat(48);
  const result = await callHubTool(hub, "device_stream_read", { sessionId: session.id, streamId });
  assert.deepEqual(result._meta?.["apple-device-hub/video"], { sessionId: session.id, streamId, sequence: 0, frames: ["encoded-video-frame"], active: true });
  assert.equal(JSON.stringify(result.content).includes("encoded-video-frame"), false);
  assert.equal(result.structuredContent, undefined);
  assert.equal((await callHubTool(hub, "device_stream_stop", { sessionId: session.id, streamId })).isError, undefined);
  assert.deepEqual(calls, [["streamRead", session.id, streamId], ["streamStop", session.id, streamId]]);
  calls.length = 0;
  assert.equal((await callHubTool(hub, "device_stream_read", { sessionId: session.id, streamId: "invalid" })).isError, true);
  assert.deepEqual(calls, []);
});

test("invalid or arbitrary device commands are rejected before calling Apple", async () => {
  const { hub, calls } = fakeHub();
  for (const args of [
    { sessionId: session.id, action: { type: "shell", command: "open /etc/passwd" } },
    { sessionId: session.id, action: { type: "tap", x: -10, y: 20 } },
    { sessionId: "untrusted-secret-key", action: { type: "tap", x: 10, y: 20 } },
  ]) assert.equal((await callHubTool(hub, "device_action", args)).isError, true);
  assert.deepEqual(calls, []);
});

test("empty settings and unknown tools cannot invoke device operations", async () => {
  const { hub, calls } = fakeHub();
  assert.equal((await callHubTool(hub, "device_settings", { sessionId: session.id, settings: {} })).isError, true);
  assert.equal((await callHubTool(hub, "DeviceInteractionSynthesize", {})).isError, true);
  assert.deepEqual(calls, []);
});

test("simulator computer tools preserve viewer preferences and route scoped actions", async () => {
  const { hub, calls } = fakeHub();
  await callHubTool(hub, "simulator_get_state", { sessionId: session.id });
  await callHubTool(hub, "simulator_screenshot", { sessionId: session.id });
  const clicked = await callHubTool(hub, "simulator_click", { sessionId: session.id, target: 3, snapshot: 7 });
  assert.equal(clicked.isError, undefined);
  assert.deepEqual(calls, [
    ["capture", session.id, { simulatorOnly: true, accessibilityEnabled: true, updateAccessibilityPreference: false }],
    ["capture", session.id, { simulatorOnly: true, accessibilityEnabled: false, updateAccessibilityPreference: false }],
    ["action", session.id, { type: "tap", element: { ref: "e3" }, clickCount: 1 }, { simulatorOnly: true, accessibilityEnabled: true, snapshot: 7 }],
  ]);
  calls.length = 0;
  assert.equal((await callHubTool(hub, "simulator_click", { sessionId: session.id, target: 3 })).isError, true);
  assert.equal((await callHubTool(hub, "simulator_press_key", { sessionId: session.id, key: "super+c" })).isError, true);
  assert.deepEqual(calls, []);
});

test("expired session results give the app a precise reconnect signal for the affected session", async () => {
  const { hub } = fakeHub();
  hub.capture = async () => { throw new SessionExpiredError(); };
  const result = await callHubTool(hub, "device_capture", { sessionId: session.id });
  assert.equal(result.isError, true);
  assert.deepEqual(result._meta, { errorCode: "SESSION_EXPIRED", sessionId: session.id });
});

test("MCP discovery advertises native host entrypoints and opening accepts empty arguments", async () => {
  const { hub } = fakeHub();
  const server = createHubServer(hub, new URL("../plugins/apple-device-hub/dist/", import.meta.url));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const opening = tools.find(tool => tool.name === "open_device_hub")!;
    assert.deepEqual((opening._meta?.["openai/ui"] as Record<string, unknown>).entrypoints, [{ type: "global" }, { type: "thread" }]);
    assert.equal((opening._meta?.ui as Record<string, unknown>).resourceUri, UI_URI);
    assert.equal(tools.some(tool => tool.name.startsWith("DeviceInteraction")), false);
    const streaming = tools.find(tool => tool.name === "device_frame")!;
    assert.deepEqual((streaming._meta?.ui as Record<string, unknown>).visibility, ["app"]);
    assert.deepEqual((tools.find(tool => tool.name === "device_stream")!._meta?.ui as Record<string, unknown>).visibility, ["app"]);
    for (const name of ["device_stream_read", "device_stream_stop", "device_input"]) {
      assert.deepEqual((tools.find(tool => tool.name === name)!._meta?.ui as Record<string, unknown>).visibility, ["app"]);
    }
    const destructive = new Set(["device_action", "device_settings", "device_disconnect", "device_stream_stop", "device_input", "simulator_click", "simulator_drag", "simulator_type_text", "simulator_press_key"]);
    const openWorld = new Set(["device_action", "device_input", "simulator_click", "simulator_drag", "simulator_type_text", "simulator_press_key"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.destructiveHint, destructive.has(tool.name), `${tool.name} reports destructive effects`);
      assert.equal(tool.annotations?.openWorldHint, openWorld.has(tool.name), `${tool.name} reports arbitrary app destinations`);
    }
    assert.equal(tools.find(tool => tool.name === "device_stream")!.annotations?.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === "device_stream_stop")!.annotations?.readOnlyHint, false);
    const resource = await client.readResource({ uri: UI_URI });
    assert.deepEqual(resource.contents[0]._meta?.ui, { prefersBorder: false });
    assert.deepEqual((tools.find(tool => tool.name === "device_capture")!._meta?.ui as Record<string, unknown>).visibility, ["app", "model"]);
    for (const name of ["simulator_get_state", "simulator_screenshot", "simulator_click", "simulator_drag", "simulator_scroll", "simulator_type_text", "simulator_press_key"]) {
      const tool = tools.find(tool => tool.name === name)!;
      assert.ok(tool, `${name} is available through MCP`);
      assert.deepEqual((tool._meta?.ui as Record<string, unknown>).visibility, ["app", "model"]);
      assert.equal(tool.annotations?.readOnlyHint, name === "simulator_get_state" || name === "simulator_screenshot");
    }
    const result = await client.callTool({ name: "open_device_hub", arguments: {} });
    assert.deepEqual(result.structuredContent, { devices: [session.device], sessions: [], warnings: [] });
  } finally { await client.close(); await server.close(); }
});
