import { readFile } from "node:fs/promises";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import type { AppleHub } from "./apple.js";
import { SessionExpiredError } from "./apple.js";
import { formatElement } from "./elements.js";
import { actionSchema, HIERARCHY_META_KEY, settingsSchema, type Capture, type CaptureState } from "./shared.js";
import { computerAction, computerInputs, type ComputerToolName } from "./computer.js";
export { HIERARCHY_META_KEY };

export const UI_URI = "ui://apple-device-hub/viewer";
export type Hub = Pick<AppleHub, "status" | "connect" | "capture" | "frame" | "stream" | "streamRead" | "streamStop" | "action" | "settings" | "disconnect" | "close">;
const sessionId = z.string().uuid();
const resolution = z.enum(["points", "full"]).optional().describe("Image size. Leave unset: the default sizes the screenshot in logical points so image pixels equal tap coordinates.");
export const toolInputs = {
  ...computerInputs,
  open_device_hub: z.object({}),
  device_hub_preferences: z.object({}),
  device_hub_status: z.object({}),
  device_connect: z.object({ deviceId: z.string().min(1).max(200) }),
  device_capture: z.object({ sessionId, accessibilityEnabled: z.boolean().optional(), resolution }),
  device_frame: z.object({ sessionId }),
  device_stream: z.object({ sessionId, codec: z.enum(["hevc", "h264"]).default("h264") }),
  device_stream_read: z.object({ sessionId, streamId: z.string().regex(/^[a-f0-9]{48}$/) }),
  device_stream_stop: z.object({ sessionId, streamId: z.string().regex(/^[a-f0-9]{48}$/) }),
  device_action: z.object({ sessionId, action: actionSchema, settle: z.boolean().optional().describe("Wait for animations to finish before observing (default true)."), resolution }),
  device_settings: z.object({ sessionId, resolution, settings: settingsSchema.refine(value => Object.values(value).some(item => item !== undefined), "Choose at least one setting.") }),
  device_disconnect: z.object({ sessionId }),
};
export type ToolName = keyof typeof toolInputs;

/** A compact, agent-readable description of the screen. The raw hierarchy stays out of model context. */
export function describeCapture(capture: Capture): string {
  const { session, coordinateSpace, screenshot } = capture;
  const lines = [
    `${session.device.name} (${session.device.kind}, ${session.device.runtime}) · session ${session.id}`,
    [capture.bundleId && `App: ${capture.bundleId}`, `Screen: ${coordinateSpace.width}×${coordinateSpace.height} pt`, capture.deviceOrientation && capture.deviceOrientation !== "Unknown" && `Orientation: ${capture.deviceOrientation}`, capture.snapshot !== undefined && `Snapshot: ${capture.snapshot}`].filter(Boolean).join(" · "),
  ];
  const pointsImage = screenshot.width === Math.round(coordinateSpace.width) && screenshot.height === Math.round(coordinateSpace.height);
  lines.push(pointsImage ? "Screenshot pixels are logical points: a pixel position in the image is a tap coordinate." : `Screenshot is ${screenshot.width}×${screenshot.height} px; scale positions to the ${coordinateSpace.width}×${coordinateSpace.height} pt coordinate space before tapping.`);
  if (capture.elements) {
    lines.push("", capture.elements.length
      ? `Elements (${capture.elements.length}). Act on one with device_action, e.g. {"type":"tap","element":{"ref":"e1"}}; "@ x,y" is its tap point:`
      : "No accessibility elements reported for this screen; use screenshot coordinates.");
    lines.push(...capture.elements.map(formatElement));
  } else {
    lines.push("", "Accessibility elements are hidden. Capture with accessibilityEnabled: true to target elements by ref or label.");
  }
  return lines.join("\n");
}

export function captureResult(capture: Capture): CallToolResult {
  const { screenshot, elements: _elements, hierarchy, ...rest } = capture;
  const state: CaptureState = { ...rest, screenshot: { mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } };
  return {
    content: [{ type: "text", text: describeCapture(capture) }, { type: "image", data: screenshot.data, mimeType: screenshot.mimeType }],
    structuredContent: state as unknown as Record<string, unknown>,
    // The viewer shows the raw tree; keeping it in _meta keeps it out of model context.
    ...(hierarchy !== undefined ? { _meta: { [HIERARCHY_META_KEY]: hierarchy } } : {}),
  };
}
function dataResult(data: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}
export async function callHubTool(hub: Hub, name: string, args: unknown): Promise<CallToolResult> {
  try {
    switch (name) {
      case "open_device_hub": case "device_hub_preferences": case "device_hub_status":
        toolInputs[name].parse(args);
        return dataResult(await hub.status());
      case "device_connect": {
        const input = toolInputs.device_connect.parse(args);
        return dataResult(await hub.connect(input.deviceId));
      }
      case "device_capture": {
        const input = toolInputs.device_capture.parse(args);
        return captureResult(await hub.capture(input.sessionId, { accessibilityEnabled: input.accessibilityEnabled, ...(input.resolution ? { resolution: input.resolution } : {}) }));
      }
      case "device_frame": {
        const input = toolInputs.device_frame.parse(args);
        return captureResult(await hub.frame(input.sessionId));
      }
      case "device_stream": {
        const input = toolInputs.device_stream.parse(args);
        return dataResult(await hub.stream(input.sessionId, input.codec));
      }
      case "device_stream_read": {
        const input = toolInputs.device_stream_read.parse(args);
        const batch = await hub.streamRead(input.sessionId, input.streamId);
        // Native video belongs only to the app. No frame bytes enter model text or structured context.
        return { content: [{ type: "text", text: "Simulator video batch." }], _meta: { "apple-device-hub/video": batch } };
      }
      case "device_stream_stop": {
        const input = toolInputs.device_stream_stop.parse(args);
        await hub.streamStop(input.sessionId, input.streamId);
        return dataResult({ stopped: true });
      }
      case "device_action": {
        const input = toolInputs.device_action.parse(args);
        return captureResult(await hub.action(input.sessionId, input.action, { ...(input.settle !== undefined ? { settle: input.settle } : {}), ...(input.resolution ? { resolution: input.resolution } : {}) }));
      }
      case "device_settings": {
        const input = toolInputs.device_settings.parse(args);
        return captureResult(await hub.settings(input.sessionId, input.settings, input.resolution ? { resolution: input.resolution } : {}));
      }
      case "device_disconnect": {
        const input = toolInputs.device_disconnect.parse(args);
        await hub.disconnect(input.sessionId);
        return dataResult({ sessionId: input.sessionId, disconnected: true });
      }
      case "simulator_get_state": case "simulator_screenshot": {
        const input = computerInputs[name].parse(args);
        return captureResult(await hub.capture(input.sessionId, { simulatorOnly: true, accessibilityEnabled: name === "simulator_get_state", updateAccessibilityPreference: false }));
      }
      case "simulator_click": case "simulator_drag": case "simulator_scroll": case "simulator_type_text": case "simulator_press_key": {
        const input = computerAction(name as ComputerToolName, args);
        return captureResult(await hub.action(input.sessionId, input.action, input.options));
      }
      default: throw new Error(`Unknown device tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      ...(error instanceof SessionExpiredError ? { _meta: { errorCode: error.code, sessionId: (args as { sessionId: string }).sessionId } } : {}),
    };
  }
}

export async function appHtml(assetRoot: URL, preview = false): Promise<string> {
  const [script, style] = await Promise.all([readFile(new URL("app.js", assetRoot), "utf8"), readFile(new URL("app.css", assetRoot), "utf8")]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apple Device Hub</title><style>${style.replaceAll("</style", "<\\/style")}</style></head><body><main id="root"></main>${preview ? '<script>globalThis.__APPLE_DEVICE_HUB_PREVIEW__=true;</script>' : ""}<script type="module">${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}

export function createHubServer(hub: Hub, assetRoot: URL): McpServer {
  const server = new McpServer({ name: "apple-device-hub", version: "0.1.0" }, { instructions: "Use open_device_hub to show the device viewer. Choose a device from device_hub_status and connect it, then capture its screen before interacting. Coordinates are logical device points in coordinateSpace, not screenshot pixels. When accessibility is enabled, use the latest hierarchy for positions. device_capture's accessibilityEnabled flag controls whether the hierarchy is exposed; it does not change iOS accessibility settings. Device operations pass through Apple's Xcode bridge. Disconnect sessions when finished." });
  registerAppResource(server, "Apple Device Hub", UI_URI, {}, async () => ({ contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await appHtml(assetRoot), _meta: { ui: { prefersBorder: false } } }] }));
  const definitions: { name: ToolName; title: string; description: string; readOnly: boolean; appOnly?: boolean; opening?: OpenAIUiToolMetadata }[] = [
    { name: "open_device_hub", title: "Apple Device Hub", description: "Open the local Apple Device Hub. View and control simulators or connected Apple devices beside the conversation.", readOnly: true, opening: { entrypoints: [{ type: "global" }, { type: "thread" }], preferredModelDisplayMode: "fullscreen" } },
    { name: "device_hub_preferences", title: "Device Hub settings", description: "Open Apple Device Hub device and accessibility controls.", readOnly: true, opening: { entrypoints: [{ type: "settings", searchTerms: ["device", "simulator", "accessibility"] }] } },
    { name: "device_hub_status", title: "List Apple devices", description: "List local simulators, paired physical device candidates, and active interaction sessions. Physical-device availability reflects discovery and pairing; successful device_connect confirms Apple's interaction eligibility.", readOnly: true },
    { name: "device_connect", title: "Connect device", description: "Start an Apple device interaction session for a device ID from the inventory. Boots a simulator when needed. Returns a local session ID; Apple's secret session key stays on the server.", readOnly: false },
    { name: "device_capture", title: "Capture device screen", description: "Observe the device: returns a screenshot sized in logical points plus a numbered list of on-screen accessibility elements (role, label, identifier, value, tap point). Call this before acting, then act on elements by ref with device_action. accessibilityEnabled shows or hides elements in the output; it does not change VoiceOver.", readOnly: true },
    { name: "device_frame", title: "Stream device frame", description: "Return a compressed screen-only frame for the live viewer. No accessibility hierarchy or settings.", readOnly: true, appOnly: true },
    { name: "device_stream", title: "Stream simulator video", description: "Open a live hardware HEVC or H.264 simulator video connection for the viewer. Accessibility and device actions continue through MCP tools.", readOnly: true, appOnly: true },
    { name: "device_stream_read", title: "Read simulator video", description: "Read a bounded batch of native video access units through the host transport for the embedded viewer.", readOnly: true, appOnly: true },
    { name: "device_stream_stop", title: "Stop simulator video", description: "Release an embedded viewer's native video relay and revoke its stream capability.", readOnly: true, appOnly: true },
    { name: "device_action", title: "Control device", description: "Act on the device, then return the resulting screen and element list after animations settle. Prefer element targets over coordinates: {\"type\":\"tap\",\"element\":{\"ref\":\"e12\"}} or {\"element\":{\"label\":\"General\",\"role\":\"Button\"}}. Refs come from the latest capture or action result. Other actions: type (optionally into an element, which is tapped first), scroll (direction is where the content goes: \"down\" reveals content below; optionally within an element), swipe with coordinates, button (home, lock, volumeUp, volumeDown), orientation, launchApp by bundle ID, openSettings. Coordinates are logical points and match pixels in the default screenshot.", readOnly: false },
    { name: "device_settings", title: "Change device settings", description: "Change device appearance, Dynamic Type size, motion, transparency, or contrast through Apple's supported local tools. Settings persist on the selected device. Returns the resulting screen and observed setting values when available.", readOnly: false },
    { name: "device_disconnect", title: "Disconnect device", description: "End the Apple interaction session and release its resources.", readOnly: false },
    { name: "simulator_get_state", title: "Observe simulator", description: "Simulator computer use: get the selected simulator's screenshot, accessibility elements, logical point coordinates and snapshot. Use element numbers or refs with this snapshot for input. Observations do not change the viewer's accessibility preference. Requires a device_connect session for a simulator.", readOnly: true },
    { name: "simulator_screenshot", title: "Simulator screenshot", description: "Simulator computer use: capture only the selected simulator's screen, sized in logical points. Returns coordinateSpace for mapping image positions. Does not change the viewer's accessibility preference.", readOnly: true },
    { name: "simulator_click", title: "Click simulator", description: "Click, double click or long press inside the selected simulator. Target an element number/ref with the snapshot from simulator_get_state, an accessibility selector, or [x,y] in logical points. Returns the resulting screen and accessibility elements. Input never targets the Mac desktop.", readOnly: false },
    { name: "simulator_drag", title: "Drag in simulator", description: "Drag from one logical [x,y] point to another inside the selected simulator. Returns the resulting screenshot and accessibility state. Use current simulator_get_state coordinates.", readOnly: false },
    { name: "simulator_scroll", title: "Scroll simulator", description: "Scroll the selected simulator, optionally at a logical [x,y] point or within an accessibility element. Down reveals content below; right reveals content to the right. Distance is a fraction of the visible region. Returns the resulting screen.", readOnly: false },
    { name: "simulator_type_text", title: "Type in simulator", description: "Type literal Unicode text inside the selected simulator, optionally focusing a target first. Target accepts [x,y], a selector or an element number/ref with its snapshot. Focus and typing execute together. Returns the resulting screen and accessibility state.", readOnly: false },
    { name: "simulator_press_key", title: "Press simulator key", description: "Press a supported keyboard or hardware key on the selected simulator: Return, Tab, Backspace, Home, Lock, VolumeUp or VolumeDown. Returns the resulting screen. Modifier shortcuts and desktop keyboard events are not exposed.", readOnly: false },
  ];
  for (const definition of definitions) {
    registerAppTool(server, definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: toolInputs[definition.name],
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { visibility: definition.appOnly ? ["app"] : ["app", "model"], ...(definition.opening ? { resourceUri: UI_URI } : {}) },
        ...(definition.opening ? { "openai/ui": definition.opening } : {}),
      },
    }, (args: unknown) => callHubTool(hub, definition.name, args));
  }
  return server;
}
