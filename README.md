# Apple Device Hub

A local MCP server and sidebar app for viewing and controlling Apple simulators and connected physical devices inside the ChatGPT desktop app. Simulators have live hardware HEVC video with H.264 fallback; device actions and accessibility observations pass through Apple's Xcode MCP bridge.

This project targets the ChatGPT/Codex desktop host with local-plugin support and uses its `global`, `thread`, and `settings` MCP App entrypoints. It does not require a cloud server or tunnel. See [VALIDATION.md](VALIDATION.md) for the host builds tested.

## Setup

Requires macOS, Node 22+, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled. Open Xcode before starting a device session. Physical devices must be paired, connected, unlocked, and configured for development.

```sh
git clone https://github.com/mweinbach/AppleSimChatGPTPlugin.git
cd AppleSimChatGPTPlugin
npm ci
npm run build
npm run typecheck
npm test
```

The plugin is built under `plugins/apple-device-hub`. The build compiles a native simulator capture helper with the selected Xcode toolchain and bundles the server and browser dependencies. Build on the Mac architecture that will run the plugin. It uses the public npm release `@openai/mcp-extensions@0.1.0`, published September 29, 2026, pinned in the lockfile. The earlier vendored preview SDK has been removed. See the [official SDK installation guide](https://github.com/openai/mcp-extensions/blob/node-v0.1.0/typescript/README.md).

## Use in ChatGPT

```sh
codex plugin marketplace add "$PWD"
codex plugin add apple-device-hub@apple-device-hub-local
```

After first installation, fully quit and reopen the ChatGPT desktop app to pick up the plugin, then start a new task so its tools load. Open **Apple Device Hub** from navigation or beside a task, or ask “Open Apple Device Hub.” The CLI and deep links retain the `codex` name because that is the installed host's plugin contract.

If an existing task shows **Failed to load** and the desktop logs report `unknown MCP server 'apple-device-hub'`, its MCP configuration predates installation. Navigation can discover the plugin before that task's server list updates. Use a new task after installation; for first installation, fully quit and reopen the desktop app first. This error occurs before the viewer's HTML loads.

Choose a device and connect to start its screen viewer. Tap or drag on the screen to interact. The shadcn/ui workbench keeps device selection and hardware controls beside the live simulator, with **Elements** and **Settings** inspector tabs. Select or hover an element to highlight its actual screen bounds; enable **Inspect** to select an element by clicking the screen, then use **Tap element** to act on its current reference. Search filters the element list by label, role, identifier, or value. Highlights and pointer gestures use logical device points and stay aligned when the viewer is scaled or rotated.

Use the keyboard field, hardware buttons, orientation, and device Settings controls as needed. Device preferences show observed values; an unsupported or unreported setting remains unknown. Disconnect when finished; idle sessions expire after five minutes. **Attach current screen** explicitly adds the current screen and enabled hierarchy to the next message when the host supports image context.

### Agent device use

The model drives devices with an observe → act loop:

1. `device_capture` returns a screenshot sized in logical points, so a pixel in the image is a tap coordinate. It also returns a numbered list of on-screen accessibility elements: role, label, identifier, value, state and tap point. The list is distilled from Xcode's hierarchy, without wrapper views, off-screen nodes, scroll bars, duplicates, or text that repeats its control's label. The raw hierarchy goes only to the viewer, in the result's `_meta`.
2. `device_action` acts on an element by ref (`{"type":"tap","element":{"ref":"e6"}}`) or by label, identifier and role (`{"element":{"label":"General","role":"Button"}}`). An ambiguous match is rejected with the candidates listed. Actions: `tap`, `type` (optionally into an element, which is tapped first), `scroll` (the direction is where the content goes; optionally within an element), `swipe`, `button`, `orientation`, `launchApp` by bundle ID, and `openSettings`.
3. Each action waits until two consecutive screenshots match, up to 2.5 s, then observes again. The result shows the screen after animations, with a fresh element list. Pass `settle: false` to skip this wait.

Refs resolve against the session's latest observation. The `Snapshot` number changes only when the element list changes, so refs from an identical re-capture stay valid.

### Simulator computer use

The `simulator_*` tools offer familiar computer-use operations bound to a connected simulator. Pass the public `sessionId` returned by `device_connect`; physical-device sessions are rejected. They never send input to the Mac desktop.

| Tool | Behavior |
| --- | --- |
| `simulator_get_state` | Screenshot, accessibility elements, logical coordinates and snapshot. |
| `simulator_screenshot` | Screen-only observation at logical-point size. |
| `simulator_click` | Click, double click (`clickCount: 2`) or long press (`duration` in seconds). |
| `simulator_drag` | Drag between logical `from: [x,y]` and `to: [x,y]` points. |
| `simulator_scroll` | Scroll in a direction, optionally at a point or within an element. |
| `simulator_type_text` | Type literal Unicode text, optionally focusing a target in the same operation. |
| `simulator_press_key` | Return, Tab, Backspace, Home, Lock, VolumeUp or VolumeDown. |

Targets accept `[x,y]`, a numbered element such as `12`, a ref such as `"e12"`, or a selector such as `{"label":"General","role":"Button"}`. Element numbers and refs require the `snapshot` returned by `simulator_get_state`. The server checks that snapshot inside the device's serial input queue and rejects outdated refs before input. Every input returns the resulting screenshot and current accessibility state. Screenshot/state observations preserve the viewer's accessibility preference. Supported keyboard keys use Apple's device event bridge; desktop shortcuts, arbitrary commands and mouse hover are not exposed by this touch-device interface.

```json
{"sessionId":"<public-session-id>","target":"e12","snapshot":4}
```

Use those arguments with `simulator_click` after observing snapshot 4. Capture again if the tool reports a stale snapshot.

The paired-device list is discovery information. Apple's bridge determines interaction eligibility when you connect, and can reject a paired device that is currently unreachable or otherwise ineligible.

The accessibility toggle shows or hides the hierarchy in the viewer and tool output. It does not change VoiceOver. Apple's interaction service can still collect a hierarchy internally, including an initial capture to establish logical touch coordinates. With the tree hidden, subsequent screenshot-only refreshes use `simctl` or `devicectl`.

Simulator Live reads CoreSimulator's primary IOSurface display, encodes it with VideoToolbox at a target of 30 fps, and delivers Annex B access units to a WebCodecs canvas. The viewer checks HEVC decoder support first. HEVC requires a hardware encoder and uses the Main profile; if HEVC capture or decoding fails, the viewer releases that stream and switches to H.264 for the connection. An explicit Retry permits a fresh HEVC attempt. H.264 retains its hardware-preferred Baseline encoder. Both codecs disable frame reordering and request a keyframe every second. HEVC's target bitrate is 60% of the H.264 target, with the same ratio between their minimum bitrates; this is a bandwidth setting, not an equal-quality guarantee.

This follows the shared-surface approach used by [KittyFarm](https://github.com/dnakov/kittyfarm/tree/2ac05cc96551a949282f04059832d923d676ff4f), with an original thin helper using CoreSimulator's screen ports. It does not poll screenshot tools for simulator video. Video keeps running during actions and settings changes. Accessibility observations refresh separately every five seconds when the tree is enabled. Rotation refreshes logical bounds before enabling touch in the new orientation. Attach current screen takes a fresh observation before attaching.

The app-only `device_stream` tool issues a short-lived stream capability for the requested codec (`hevc` or `h264`; older callers default to H.264). The embedded viewer reads bounded batches of encoded video through `device_stream_read`, using the existing MCP host transport. Video bytes travel only in app metadata. This avoids the production host's restriction on insecure loopback WebSockets. The standalone preview retains direct WebSocket playback through a listener bound to `127.0.0.1`. Viewers of the same session and codec share an encoder and begin with a complete keyframe; HEVC and H.264 viewers remain independent. Turning Live off, hiding the viewer, closing the last viewer, or disconnecting releases native capture; unused relays also expire. Slow viewers reset at a keyframe or reconnect; capture failures show an explicit error and a Retry video action. The browser must support H.264 decoding through WebCodecs. After repeated H.264 failures, the viewer falls back to screen refreshes while retaining the error and Retry control.

Physical devices retain compressed screenshot refreshes through app-only `device_frame`. While disconnected, Live checks for a session started from chat and adopts one matching the selected device, or the sole active session. Turning Live off pauses that watcher too.

The viewer reads the device's current appearance, Dynamic Type size, motion, transparency, and contrast settings before displaying their values. Changes use `simctl` or the current simulator-capable `devicectl` APIs. Unsupported controls report a concrete error. Open the device Settings app for other preferences. Setting changes persist on the device.

## Development

```sh
npm run preview
```

Open `http://127.0.0.1:4319` for a standalone preview of the same real backend. This is a development viewer; the installed MCP App uses tool calls directly. The preview binds only to loopback and rejects requests from unrelated browser origins. Set `APPLE_DEVICE_HUB_PREVIEW_PORT` to choose another port.

The browser UI uses React, shadcn/ui (Radix Nova), and Tailwind CSS. `components.json` configures the component source under `src/components/ui`. The build bundles React and the compiled CSS into the self-contained MCP HTML resource; no CDN or separate web server is needed in the host. Rebuild and reload the preview to pick up UI changes without restarting the preview backend.

`npm start` runs the local stdio MCP server. The root `.mcp.json` is a project launch configuration; the plugin's `.mcp.json` launches its bundled runtime. Keep server diagnostics on stderr.

For updates, rebuild, apply the plugin-creator cachebuster workflow, and reinstall from `apple-device-hub-local`. The checked-in marketplace points at this project's built plugin.

## Boundaries

- Simulator video uses private CoreSimulator screen APIs. A future Xcode change may require updating the helper; stream failures report their cause in the viewer. Physical-device video, linked input replication, and KittyFarm's Build & Play workflow are outside this implementation.
- Xcode's own event handling sets action latency: taps take about 0.6 s, and hardware buttons such as Home can take about 5 s inside Xcode. The idle wait adds about 1 s on a still screen.
- Tap/swipe coordinates are logical points from the most recent native window hierarchy. Screenshot pixel dimensions can differ by the device's display scale.
- Only typed device actions and supported settings are exposed. Apple's session secret and local artifact paths stay server-side.
- A successful build or protocol inspection does not establish real-host rendering. Validate the app in ChatGPT separately from the standalone preview.
- Live capture updates the selected session and discovers a replacement after a session closes. Immediate host notification routing and screenshot attachment submission require host acceptance testing.

See [VALIDATION.md](VALIDATION.md) for the checks completed on this Mac and the remaining host and physical-device validation limits.
