import { readFile } from "node:fs/promises";
import { version } from "./version.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import type { AppleHub } from "./apple.js";
import { SessionExpiredError } from "./apple.js";
import { formatElement } from "./elements.js";
import { actionSchema, DATA_META_KEY, HIERARCHY_META_KEY, liveInputSchema, settingsSchema, type Capture, type CaptureState, type ConnectedSession, type Device, type HubState } from "./shared.js";
import { computerAction, computerInputs, screenshotOption, type ComputerToolName } from "./computer.js";
export { DATA_META_KEY, HIERARCHY_META_KEY };

export const UI_URI = "ui://apple-device-hub/viewer";
export type Hub = Pick<AppleHub, "status" | "connect" | "capture" | "frame" | "stream" | "streamRead" | "streamStop" | "input" | "action" | "settings" | "disconnect" | "createSimulator" | "deleteSimulator" | "close">;
const deviceId = z.string().min(1).max(200);
const sessionId = z.string().uuid();
const resolution = z.enum(["points", "full"]).optional().describe("Image size. Leave unset: the default sizes the screenshot in logical points so image pixels equal tap coordinates.");
export const toolInputs = {
  ...computerInputs,
  open_device_hub: z.object({}),
  device_hub_preferences: z.object({}),
  device_hub_status: z.object({}),
  device_connect: z.object({
    deviceId,
    takeOver: z.boolean().optional().describe("Join a session another tool holds on this device. Ask the user first; sessions from other Device Hub chats or windows are joined without it."),
  }),
  simulator_create: z.object({
    deviceType: z.string().min(1).max(200).optional().describe("Simulator type such as \"iPhone 17 Pro\" or \"iPad Air 13-inch (M4)\"; an unknown name lists the choices."),
    runtime: z.string().min(1).max(100).optional().describe("Runtime such as \"iOS 27.2\" or \"iOS 27\"; the newest that supports the type when unset."),
    cloneFrom: deviceId.optional().describe("ID of a shut-down simulator to copy with its apps and data, instead of deviceType."),
    name: z.string().min(1).max(100).optional().describe("Name for the new simulator; defaults to the type with \"(Device Hub)\"."),
    connect: z.boolean().default(true).describe("Boot the simulator and open a session (default true)."),
  }).refine(value => Boolean(value.deviceType) !== Boolean(value.cloneFrom), "Choose either deviceType or cloneFrom."),
  simulator_delete: z.object({ deviceId }),
  device_capture: z.object({ sessionId, accessibilityEnabled: z.boolean().optional(), resolution, screenshot: screenshotOption }),
  device_frame: z.object({ sessionId }),
  device_stream: z.object({ sessionId, codec: z.enum(["hevc", "h264"]).default("h264"), maxDimension: z.number().int().min(320).max(8192).optional().describe("Longest encoded edge in pixels; the simulator's resolution when larger or unset.") }),
  device_stream_read: z.object({ sessionId, streamId: z.string().regex(/^[a-f0-9]{48}$/) }),
  device_stream_stop: z.object({ sessionId, streamId: z.string().regex(/^[a-f0-9]{48}$/) }),
  device_input: z.object({ sessionId, events: z.array(liveInputSchema).min(1).max(64) }),
  device_action: z.object({ sessionId, action: actionSchema, settle: z.boolean().optional().describe("Wait for animations to finish before observing (default true)."), resolution, screenshot: screenshotOption }),
  device_settings: z.object({ sessionId, resolution, screenshot: screenshotOption, settings: settingsSchema.refine(value => Object.values(value).some(item => item !== undefined), "Choose at least one setting.") }),
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
  if (capture.settings && Object.keys(capture.settings).length) {
    lines.push(`Settings: ${Object.entries(capture.settings).map(([name, value]) => `${name} ${value}`).join(", ")}. Restore changed settings when finished.`);
  }
  if (!screenshot) {
    lines.push(capture.elements?.length
      ? "No screenshot attached; the elements below describe the screen. Pass screenshot: \"always\" to check visual details such as layout, color or images."
      : "No screenshot attached.");
  } else if (screenshot.width === Math.round(coordinateSpace.width) && screenshot.height === Math.round(coordinateSpace.height)) {
    lines.push("Screenshot pixels are logical points: a pixel position in the image is a tap coordinate.");
  } else {
    lines.push(`Screenshot is ${screenshot.width}×${screenshot.height} px; scale positions to the ${coordinateSpace.width}×${coordinateSpace.height} pt coordinate space before tapping.`);
  }
  if (capture.elements) {
    lines.push("", capture.elements.length
      ? `Elements (${capture.elements.length}). Act on one with device_action, e.g. {"type":"tap","element":{"ref":"e1"}}; "@ x,y" is its tap point, followed by its size in points:`
      : "No accessibility elements reported for this screen; use screenshot coordinates.");
    lines.push(...capture.elements.map(formatElement));
  } else {
    lines.push("", "Accessibility elements are hidden. Capture with accessibilityEnabled: true to target elements by ref or label.");
  }
  return lines.join("\n");
}

export function captureResult(capture: Capture): CallToolResult {
  const { screenshot, elements: _elements, hierarchy, ...rest } = capture;
  const state: CaptureState = { ...rest, ...(screenshot ? { screenshot: { mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } } : {}) };
  return {
    content: [{ type: "text", text: describeCapture(capture) }, ...(screenshot ? [{ type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType }] : [])],
    // The viewer shows the raw tree; keeping it in _meta keeps it out of model context.
    _meta: { [DATA_META_KEY]: state, ...(hierarchy !== undefined ? { [HIERARCHY_META_KEY]: hierarchy } : {}) },
  };
}
/** For app-only tools, which the model never calls. */
function dataResult(data: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}
/** The model reads the text; the viewer reads the data. */
function textResult(text: string, data: object): CallToolResult {
  return { content: [{ type: "text", text }], _meta: { [DATA_META_KEY]: data } };
}

const deviceLine = (device: Device) => `${device.name} · ${device.runtime || device.platform}${device.kind === "device" ? " · physical device" : ""} · id ${device.id}${device.createdByHub ? " · created by Device Hub" : ""}`;
const newestFirst = (left: Device, right: Device) => right.runtime.localeCompare(left.runtime, undefined, { numeric: true }) || left.name.localeCompare(right.name, undefined, { numeric: true });

/** What the model needs to pick, join or create a session, without the full device JSON. */
export function describeHub(state: HubState): string {
  const lines: string[] = [];
  const connected = new Set(state.sessions.map(session => session.device.id));
  const shared = new Set(state.elsewhere?.map(session => session.deviceId));
  if (state.sessions.length) {
    lines.push("Sessions on this server (pass the session ID to other tools):", ...state.sessions.map(session =>
      `- ${session.device.name} (${session.device.kind}, ${session.device.runtime}) · session ${session.id}${state.focus?.deviceId === session.device.id ? " · shown in the viewer" : ""}${shared.has(session.device.id) ? " · shared with another chat or window" : ""}`));
  } else {
    lines.push("No sessions on this server. device_connect opens one, or joins one already open in another chat or window.");
  }
  const elsewhere = state.elsewhere?.filter(session => !connected.has(session.deviceId)) ?? [];
  if (elsewhere.length) {
    lines.push("", "Open in another Device Hub chat or window (device_connect joins and shares it):", ...elsewhere.map(session =>
      `- ${session.deviceName} · id ${session.deviceId}${session.otherTool ? " · taken over from another tool" : ""}`));
  }
  const available = state.devices.filter(device => device.available && !connected.has(device.id));
  const running = available.filter(device => device.kind === "simulator" ? device.state === "Booted" : /connected/i.test(device.state));
  const stopped = available.filter(device => device.kind === "simulator" && !running.includes(device)).sort(newestFirst);
  const physical = state.devices.filter(device => device.kind === "device" && !connected.has(device.id) && !running.includes(device));
  if (running.length) lines.push("", "Running (the user may be using these):", ...running.map(device => `- ${deviceLine(device)}`));
  if (stopped.length) {
    lines.push("", `Shut-down simulators (device_connect boots one):`, ...stopped.slice(0, 40).map(device => `- ${deviceLine(device)}`));
    if (stopped.length > 40) lines.push(`- …and ${stopped.length - 40} more`);
  }
  if (physical.length) lines.push("", "Physical devices:", ...physical.map(device => `- ${deviceLine(device)} · ${device.available ? device.state : "unavailable"}`));
  if (!state.devices.length) lines.push("", "No simulators or devices found.");
  lines.push("", "simulator_create makes a fresh simulator, or clones a shut-down one, so testing does not disturb the user's own devices.");
  if (state.warnings.length) lines.push("", ...state.warnings);
  return lines.join("\n");
}

const origins = {
  "new": "",
  "this-server": " This session was already open on this server, possibly in the viewer, so you share it with the user.",
  "device-hub": " Joined the session another Device Hub chat or window holds. Both can drive the device, so observe before acting.",
  "other-tool": " Took over another tool's Xcode session. That tool may still drive the device, and Device Hub will not end its session.",
} as const;
export function describeConnection(session: ConnectedSession): string {
  return `Connected to ${session.device.name} (${session.device.kind}, ${session.device.runtime}). Session ID: ${session.id}.${origins[session.origin]} The viewer now shows this device. Observe with device_capture or simulator_get_state before acting.`;
}
export async function callHubTool(hub: Hub, name: string, args: unknown): Promise<CallToolResult> {
  try {
    switch (name) {
      case "open_device_hub": case "device_hub_preferences": case "device_hub_status": {
        toolInputs[name].parse(args);
        const state = await hub.status();
        return textResult(describeHub(state), state);
      }
      case "device_connect": {
        const input = toolInputs.device_connect.parse(args);
        const session = await hub.connect(input.deviceId, input.takeOver ? { takeOver: true } : {});
        return textResult(describeConnection(session), session);
      }
      case "simulator_create": {
        const input = toolInputs.simulator_create.parse(args);
        const device = await hub.createSimulator({ ...(input.deviceType ? { deviceType: input.deviceType } : {}), ...(input.runtime ? { runtime: input.runtime } : {}), ...(input.cloneFrom ? { cloneFrom: input.cloneFrom } : {}), ...(input.name ? { name: input.name } : {}) });
        const created = `Created ${device.name} (${device.runtime}), id ${device.id}. simulator_delete removes it when you are done.`;
        if (!input.connect) return textResult(`${created} device_connect boots it.`, { device });
        const session = await hub.connect(device.id);
        return textResult(`${created} ${describeConnection(session)}`, session);
      }
      case "simulator_delete": {
        const input = toolInputs.simulator_delete.parse(args);
        const device = await hub.deleteSimulator(input.deviceId);
        return textResult(`Deleted ${device.name}.`, { deviceId: device.id, deleted: true });
      }
      case "device_capture": {
        const input = toolInputs.device_capture.parse(args);
        return captureResult(await hub.capture(input.sessionId, { accessibilityEnabled: input.accessibilityEnabled, screenshot: input.screenshot, ...(input.resolution ? { resolution: input.resolution } : {}) }));
      }
      case "device_frame": {
        const input = toolInputs.device_frame.parse(args);
        return captureResult(await hub.frame(input.sessionId));
      }
      case "device_stream": {
        const input = toolInputs.device_stream.parse(args);
        return dataResult(await hub.stream(input.sessionId, input.codec, input.maxDimension));
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
      case "device_input": {
        const input = toolInputs.device_input.parse(args);
        await hub.input(input.sessionId, input.events);
        return dataResult({ delivered: input.events.length });
      }
      case "device_action": {
        const input = toolInputs.device_action.parse(args);
        return captureResult(await hub.action(input.sessionId, input.action, { screenshot: input.screenshot, ...(input.settle !== undefined ? { settle: input.settle } : {}), ...(input.resolution ? { resolution: input.resolution } : {}) }));
      }
      case "device_settings": {
        const input = toolInputs.device_settings.parse(args);
        return captureResult(await hub.settings(input.sessionId, input.settings, { screenshot: input.screenshot, ...(input.resolution ? { resolution: input.resolution } : {}) }));
      }
      case "device_disconnect": {
        const input = toolInputs.device_disconnect.parse(args);
        await hub.disconnect(input.sessionId);
        return textResult("Disconnected. The device stays as it is, and another chat or window sharing it keeps its session.", { sessionId: input.sessionId, disconnected: true });
      }
      case "simulator_get_state": {
        const input = computerInputs.simulator_get_state.parse(args);
        return captureResult(await hub.capture(input.sessionId, { simulatorOnly: true, accessibilityEnabled: true, updateAccessibilityPreference: false, screenshot: input.screenshot }));
      }
      case "simulator_screenshot": {
        const input = computerInputs.simulator_screenshot.parse(args);
        return captureResult(await hub.capture(input.sessionId, { simulatorOnly: true, accessibilityEnabled: false, updateAccessibilityPreference: false, screenshot: "always" }));
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
  const server = new McpServer({ name: "apple-device-hub", version }, { instructions: "Use open_device_hub to show the device viewer. device_hub_status lists sessions on this server, devices open in other Device Hub chats or windows, and every device. Reuse a listed session ID, or device_connect a device: it boots a stopped simulator, reuses this server's session, or joins the one another chat or window holds, and the viewer follows it. To keep testing off the user's own simulator, simulator_create makes a fresh one (or clones a shut-down one); simulator_delete removes it afterwards. Observe before acting. Work in small verified steps: observe, act on one element by ref, then read the returned screen to confirm the result before the next step. Results are text-first: the element list describes the screen, and with the default screenshot: \"auto\" an image is attached only when the elements cannot describe it. Pass screenshot: \"always\" to judge layout, color or images. Coordinates are logical device points in coordinateSpace. accessibilityEnabled controls whether elements are exposed; it does not change iOS accessibility settings. Device operations pass through Apple's Xcode bridge. Restore changed settings and disconnect sessions when finished." });
  registerAppResource(server, "Apple Device Hub", UI_URI, {}, async () => ({ contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await appHtml(assetRoot), _meta: { ui: { prefersBorder: false } } }] }));
  const definitions: { name: ToolName; title: string; description: string; readOnly: boolean; destructive?: boolean; openWorld?: boolean; appOnly?: boolean; opening?: OpenAIUiToolMetadata }[] = [
    { name: "open_device_hub", title: "Apple Device Hub", description: "Open the local Apple Device Hub. View and control simulators or connected Apple devices beside the conversation.", readOnly: true, opening: { entrypoints: [{ type: "global" }, { type: "thread" }], preferredModelDisplayMode: "fullscreen" } },
    { name: "device_hub_preferences", title: "Device Hub settings", description: "Open Apple Device Hub device and accessibility controls.", readOnly: true, opening: { entrypoints: [{ type: "settings", searchTerms: ["device", "simulator", "accessibility"] }] } },
    { name: "device_hub_status", title: "List Apple devices", description: "List sessions open on this server (reuse their session IDs), devices open in other Device Hub chats or windows, running devices, shut-down simulators and paired physical devices. Physical-device availability reflects discovery and pairing; device_connect confirms Apple's interaction eligibility.", readOnly: true },
    { name: "device_connect", title: "Connect device", description: "Open an interaction session on a device ID from device_hub_status and show it in the viewer. Boots a stopped simulator. If this server already has a session for the device, returns it; if another Device Hub chat or window holds the device, joins and shares that session. A device held by another tool needs takeOver: true, after asking the user. Returns a session ID for the other tools; Xcode's session key stays on the server.", readOnly: false },
    { name: "simulator_create", title: "Create simulator", description: "Create a new simulator by device type (for example \"iPhone 17 Pro\"), optionally on a specific runtime, or clone a shut-down simulator with its apps and data. By default it boots the simulator and opens a session, returning the session ID. Use it to test without disturbing the user's own simulators.", readOnly: false },
    { name: "simulator_delete", title: "Delete simulator", description: "End its sessions, shut down and delete a simulator that Device Hub created with simulator_create, including in viewers that followed it. Refuses any other simulator.", readOnly: false, destructive: true },
    { name: "device_capture", title: "Capture device screen", description: "Observe the device: returns the on-screen accessibility elements (role, label, identifier, value, tap point) as text, plus a screenshot sized in logical points when the elements cannot describe the screen or screenshot is \"always\". Call this before acting, then act on elements by ref with device_action. accessibilityEnabled shows or hides elements in the output; it does not change VoiceOver.", readOnly: true },
    { name: "device_frame", title: "Stream device frame", description: "Return a compressed screen-only frame for the live viewer. No accessibility hierarchy or settings.", readOnly: true, appOnly: true },
    { name: "device_stream", title: "Stream simulator video", description: "Start a stateful live hardware HEVC or H.264 simulator video connection for the viewer. Accessibility and device actions continue through MCP tools.", readOnly: false, appOnly: true },
    { name: "device_stream_read", title: "Read simulator video", description: "Read a bounded batch of native video access units through the host transport for the embedded viewer.", readOnly: true, appOnly: true },
    { name: "device_stream_stop", title: "Stop simulator video", description: "Release an embedded viewer's native video relay and revoke its stream capability.", readOnly: false, destructive: true, appOnly: true },
    { name: "device_input", title: "Live simulator input", description: "Deliver the viewer's live touches and Home presses to a simulator with running video. Coordinates are fractions of the displayed video frame; timing between events is preserved.", readOnly: false, destructive: true, openWorld: true, appOnly: true },
    { name: "device_action", title: "Control device", description: "Act on the device, then return the resulting element list (and a screenshot per the screenshot option) after animations settle. Prefer element targets over coordinates: {\"type\":\"tap\",\"element\":{\"ref\":\"e12\"}} or {\"element\":{\"label\":\"General\",\"role\":\"Button\"}}. Refs come from the latest capture or action result. Other actions: type (optionally into an element, which is tapped first), scroll (direction is where the content goes: \"down\" reveals content below; optionally within an element), swipe with coordinates, button (home, lock, volumeUp, volumeDown), orientation, launchApp by bundle ID, openSettings. Coordinates are logical points and match pixels in the default screenshot.", readOnly: false, destructive: true, openWorld: true },
    { name: "device_settings", title: "Change device settings", description: "Change device appearance, Dynamic Type size, motion, transparency, or contrast through Apple's supported local tools. Settings persist on the selected device. Returns the resulting screen and observed setting values when available.", readOnly: false, destructive: true },
    { name: "device_disconnect", title: "Disconnect device", description: "End the Apple interaction session and release its resources.", readOnly: false, destructive: true },
    { name: "simulator_get_state", title: "Observe simulator", description: "Simulator computer use: get the selected simulator's accessibility elements, logical point coordinates and snapshot, with a screenshot when the elements cannot describe the screen or screenshot is \"always\". Use element numbers or refs with this snapshot for input. Observations do not change the viewer's accessibility preference. Requires a device_connect session for a simulator.", readOnly: true },
    { name: "simulator_screenshot", title: "Simulator screenshot", description: "Simulator computer use: always capture an image of the selected simulator's screen, sized in logical points, without the element list. Returns coordinateSpace for mapping image positions. Does not change the viewer's accessibility preference.", readOnly: true },
    { name: "simulator_click", title: "Click simulator", description: "Click, double click or long press inside the selected simulator. Target an element number/ref with the snapshot from simulator_get_state, an accessibility selector, or [x,y] in logical points. Returns the resulting screen and accessibility elements. Input never targets the Mac desktop.", readOnly: false, destructive: true, openWorld: true },
    { name: "simulator_drag", title: "Drag in simulator", description: "Drag from one logical [x,y] point to another inside the selected simulator. Returns the resulting screen and accessibility state. Use current simulator_get_state coordinates.", readOnly: false, destructive: true, openWorld: true },
    { name: "simulator_scroll", title: "Scroll simulator", description: "Scroll the selected simulator, optionally at a logical [x,y] point or within an accessibility element. Down reveals content below; right reveals content to the right. Distance is a fraction of the visible region. Returns the resulting screen.", readOnly: false },
    { name: "simulator_type_text", title: "Type in simulator", description: "Type literal Unicode text inside the selected simulator, optionally focusing a target first. Target accepts [x,y], a selector or an element number/ref with its snapshot. Focus and typing execute together. Returns the resulting screen and accessibility state.", readOnly: false, destructive: true, openWorld: true },
    { name: "simulator_press_key", title: "Press simulator key", description: "Press a supported keyboard or hardware key on the selected simulator: Return, Tab, Backspace, Home, Lock, VolumeUp or VolumeDown. Returns the resulting screen. Modifier shortcuts and desktop keyboard events are not exposed.", readOnly: false, destructive: true, openWorld: true },
  ];
  for (const definition of definitions) {
    registerAppTool(server, definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: toolInputs[definition.name],
      annotations: { readOnlyHint: definition.readOnly, destructiveHint: definition.destructive ?? false, openWorldHint: definition.openWorld ?? false },
      _meta: {
        ui: { visibility: definition.appOnly ? ["app"] : ["app", "model"], ...(definition.opening ? { resourceUri: UI_URI } : {}) },
        ...(definition.opening ? { "openai/ui": definition.opening } : {}),
      },
    }, (args: unknown) => callHubTool(hub, definition.name, args));
  }
  return server;
}
