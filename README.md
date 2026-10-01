# Apple Device Hub

A local MCP server and sidebar app for viewing and controlling Apple simulators and connected physical devices inside the ChatGPT desktop app. Simulators have live hardware HEVC video with H.264 fallback; device actions and accessibility observations pass through Apple's Xcode MCP bridge.

This project targets the ChatGPT/Codex desktop host with local-plugin support and uses its `global`, `thread`, and `settings` MCP App entrypoints. It does not require a cloud server or tunnel. See [VALIDATION.md](VALIDATION.md) for the host builds tested, [privacy and data handling](docs/PRIVACY.md), and the [gallery submission packet](docs/gallery/SUBMISSION.md).

## Install

Requires an Apple Silicon Mac, macOS 14+, Node 22+, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled. Open Xcode before starting a device session. Physical devices must be paired, connected, unlocked, and configured for development.

Install the plugin with the `codex` CLI:

```sh
codex plugin marketplace add mweinbach/AppleSimChatGPTPlugin
codex plugin add apple-device-hub@apple-device-hub
```

Fully quit and reopen the ChatGPT desktop app, then start a new chat. The plugin adds the Apple Device Hub viewer, its MCP server, and skills that teach the agent to test apps on a device. The server is the `apple-device-hub-mcp` npm package of the same version, started with `npx`; the first launch downloads it once. The package includes a signed arm64 capture helper, so nothing is compiled on your Mac.

To update, run `codex plugin marketplace upgrade apple-device-hub` and `codex plugin add apple-device-hub@apple-device-hub`, then start a new chat. To uninstall, run `codex plugin remove apple-device-hub@apple-device-hub`. A copy installed with the earlier `npx apple-sim-chatgpt-plugin install` command is removed with `codex plugin remove apple-device-hub@apple-sim-chatgpt-plugin`.

To use only the MCP server in another client, configure it with:

```json
{
  "mcpServers": {
    "apple-device-hub": {
      "command": "npx",
      "args": ["--yes", "apple-device-hub-mcp@latest"]
    }
  }
}
```

## Use in ChatGPT

Open **Apple Device Hub** from navigation or beside a chat, or ask “Open Apple Device Hub.” The CLI and deep links retain the `codex` name because that is the installed host's plugin contract.

If a chat shows **Failed to load** and the desktop logs report `unknown MCP server 'apple-device-hub'`, the chat started before the plugin was installed. Start a new chat; after a first installation, fully quit and reopen the desktop app first.

The viewer is built for the side panel, where you watch the agent work and step in when needed. Choose a device from the list; running simulators come first and connect in one click, and a stopped simulator boots. The device then fills the panel. Click or drag the screen to touch it: with simulator video running, touches stream to the simulator as you move and Home responds immediately; otherwise a click or drag is sent as one tap or swipe through Xcode.

Every action taken through the tools, by the agent or by you, appears on the live screen as it happens: a mark where it tapped or swiped, and a caption such as `e12 Tap “Settings”`. **Show what the agent sees** overlays the numbered element refs the model acts on, so you can check its narration against the screen; hover an element to name it. The controls hold Home, Lock, Rotate, typing, that overlay, the **Elements** and **Appearance** panels, and **Attach screen to your next message**. They sit in a dock below the screen in the side panel, and in the top bar of a wider window, where Elements and Appearance open as a column beside the device. Elements lists the same refs with labels, roles and values, filters them, picks one from the screen, and taps it. Appearance changes light or dark mode, text size, motion, transparency and contrast; it shows observed values, and an unreported setting stays unknown. The viewer keeps its controls clear of the host's floating composer using the safe-area insets the host reports. Disconnect when finished; idle sessions expire after five minutes. Attaching a screen adds it and any element list to your next message when the host supports image context.

### Agent device use

The model drives devices with an observe → act → verify loop, text first:

1. `device_capture` returns a numbered list of on-screen accessibility elements: role, label, identifier, value, state, tap point and size. The list is distilled from Xcode's hierarchy, without wrapper views, off-screen nodes, scroll bars, duplicates, or text that repeats its control's label. The raw hierarchy goes only to the viewer, in the result's `_meta`. With the default `screenshot: "auto"`, a screenshot is attached only when the list cannot describe the screen (fewer than three elements, or elements hidden); `"always"` attaches one for visual checks and `"never"` returns text only. Screenshots are sized in logical points, so a pixel in the image is a tap coordinate. A typical text-only observation is about 2 KB instead of a 60 KB image.
2. `device_action` acts on an element by ref (`{"type":"tap","element":{"ref":"e6"}}`) or by label, identifier and role (`{"element":{"label":"General","role":"Button"}}`). An ambiguous match is rejected with the candidates listed. Actions: `tap`, `type` (optionally into an element, which is tapped first), `scroll` (the direction is where the content goes; optionally within an element), `swipe`, `button`, `orientation`, `launchApp` by bundle ID, and `openSettings`.
3. Each action waits until two consecutive screenshots match, up to 2.5 s, then observes again. The result shows the screen after animations, with a fresh element list. Pass `settle: false` to skip this wait.

Refs resolve against the session's latest observation. The `Snapshot` number changes only when the element list changes, so refs from an identical re-capture stay valid.

Calls are bounded so a prompt never hangs on the device. Xcode requests time out after 40 s with an actionable message, and any request returns within 55 s, even one queued behind a stuck request, without ever sending its input late. Connecting gets 100 s because its first observation boots a stopped simulator; Codex allows MCP tools 300 s and a 30 s server start, which covers the first `npx` download.

### Simulator computer use

The `simulator_*` tools offer familiar computer-use operations bound to a connected simulator. Pass the public `sessionId` returned by `device_connect`; physical-device sessions are rejected. They never send input to the Mac desktop.

| Tool | Behavior |
| --- | --- |
| `simulator_get_state` | Accessibility elements, logical coordinates and snapshot, with a screenshot per `screenshot`. |
| `simulator_screenshot` | Screen-only image at logical-point size. |
| `simulator_click` | Click, double click (`clickCount: 2`) or long press (`duration` in seconds). |
| `simulator_drag` | Drag between logical `from: [x,y]` and `to: [x,y]` points. |
| `simulator_scroll` | Scroll in a direction, optionally at a point or within an element. |
| `simulator_type_text` | Type literal Unicode text, optionally focusing a target in the same operation. |
| `simulator_press_key` | Return, Tab, Backspace, Home, Lock, VolumeUp or VolumeDown. |

Targets accept `[x,y]`, a numbered element such as `12`, a ref such as `"e12"`, or a selector such as `{"label":"General","role":"Button"}`. Element numbers and refs require the `snapshot` returned by `simulator_get_state`. The server checks that snapshot inside the device's serial input queue and rejects outdated refs before input. Every input returns the resulting accessibility state, with a screenshot per `screenshot`. Screenshot/state observations preserve the viewer's accessibility preference. Supported keyboard keys use Apple's device event bridge; desktop shortcuts, arbitrary commands and mouse hover are not exposed by this touch-device interface.

```json
{"sessionId":"<public-session-id>","target":"e12","snapshot":4}
```

Use those arguments with `simulator_click` after observing snapshot 4. Capture again if the tool reports a stale snapshot.

The paired-device list is discovery information. Apple's bridge determines interaction eligibility when you connect, and can reject a paired device that is currently unreachable or otherwise ineligible.

The accessibility toggle shows or hides the hierarchy in the viewer and tool output. It does not change VoiceOver. Apple's interaction service can still collect a hierarchy internally, including an initial capture to establish logical touch coordinates. With the tree hidden, subsequent screenshot-only refreshes use `simctl` or `devicectl`.

Simulator Live reads CoreSimulator's primary IOSurface display, encodes each frame the simulator renders with VideoToolbox, and delivers Annex B access units to a WebCodecs canvas. Video follows the simulator's own rate, 60 fps on current iOS runtimes; a static screen refreshes once per second. The status line reports the measured rate, or idle when nothing is changing. The stream is encoded at the size the viewer displays it, up to the simulator's resolution, and restarts larger if the panel grows or the device rotates to landscape. The viewer checks HEVC decoder support first. HEVC requires a hardware encoder and uses the Main profile; if HEVC capture or decoding fails, the viewer releases that stream and switches to H.264 for the connection. An explicit Retry permits a fresh HEVC attempt. H.264 retains its hardware-preferred Baseline encoder; the server declares its decode order in the SPS so hardware decoders release each frame immediately. Both codecs disable frame reordering. Keyframes arrive first, for each new viewer, and every two seconds while the screen changes. HEVC's target bitrate is 60% of the H.264 target, with the same ratio between their minimum bitrates; this is a bandwidth setting, not an equal-quality guarantee.

Live touch uses SimulatorKit's HID client, the path Simulator.app's own digitizer uses, through the video helper. Pointer down, move and up events go to the simulator as they happen, with their original spacing preserved so flicks keep their velocity. Home uses the same path. On this Mac, a touch reached the next rendered frame in about 80 ms and Home in about 0.25–0.4 s, compared with about 0.6 s per tap and about 5 s for Home through Xcode. Touch coordinates are fractions of the displayed frame, so they need no accessibility observation and stay correct after rotation. If live input is unavailable, the viewer reports why and uses Xcode input.

This follows the shared-surface approach used by [KittyFarm](https://github.com/dnakov/kittyfarm/tree/2ac05cc96551a949282f04059832d923d676ff4f), with an original thin helper using CoreSimulator's screen ports. It does not poll screenshot tools for simulator video. Video keeps running during actions and settings changes. Accessibility observations refresh separately every five seconds when the tree is enabled. Rotation refreshes logical bounds before Xcode input and element highlights resume in the new orientation. Attach current screen takes a fresh observation before attaching.

The app-only `device_stream` tool issues a short-lived stream capability for the requested codec (`hevc` or `h264`; older callers default to H.264). The embedded viewer reads bounded batches of encoded video through `device_stream_read`, using the existing MCP host transport. A read returns as soon as a frame is available, and batches are numbered so a lost batch reconnects instead of corrupting the picture. The viewer keeps one read pending, because the desktop host runs at most three requests per app at once and live input through app-only `device_input` must not wait behind video. Video bytes travel only in app metadata. This avoids the production host's restriction on insecure loopback WebSockets. The standalone preview retains direct WebSocket playback through a listener bound to `127.0.0.1`. Viewers of the same session and codec share an encoder and begin with a complete keyframe; HEVC and H.264 viewers remain independent. Turning Live off, hiding the viewer, closing the last viewer, or disconnecting releases native capture; unused relays also expire. Slow viewers reset at a keyframe or reconnect; capture failures show an explicit error and a Retry video action. The browser must support H.264 decoding through WebCodecs. After repeated H.264 failures, the viewer falls back to screen refreshes while retaining the error and Retry control.

Physical devices retain compressed screenshot refreshes through app-only `device_frame`. While disconnected, Live checks for a session started from chat and adopts one matching the selected device, or the sole active session. Turning Live off pauses that watcher too.

The viewer reads the device's current appearance, Dynamic Type size, motion, transparency, and contrast settings before displaying their values. Changes use `simctl` or the current simulator-capable `devicectl` APIs. Unsupported controls report a concrete error. Open the device Settings app for other preferences. Setting changes persist on the device.

## Development

```sh
git clone https://github.com/mweinbach/AppleSimChatGPTPlugin.git
cd AppleSimChatGPTPlugin
npm ci
npm run build
npm run typecheck
npm test
```

The build compiles the arm64 capture helper with the selected Xcode, bundles the server and viewer into `packages/apple-device-hub-mcp/dist`, and copies that runtime to `plugins/apple-device-hub/dist` for local use. It uses the public npm release `@openai/mcp-extensions@0.1.0`, pinned in the lockfile. See the [official SDK installation guide](https://github.com/openai/mcp-extensions/blob/node-v0.1.0/typescript/README.md).

To try your changes in ChatGPT, run `npm run dev:plugin`, then start a new chat. It rebuilds, installs this checkout's plugin and server as `apple-device-hub@apple-device-hub-dev` in place of the published plugin, and gives each build a distinct version so the host reloads it. Return to the published plugin with `codex plugin remove apple-device-hub@apple-device-hub-dev` and `codex plugin add apple-device-hub@apple-device-hub`.

```sh
npm run preview
```

Open `http://127.0.0.1:4319` for a standalone preview of the same real backend. This is a development viewer; the installed MCP App uses tool calls directly. The preview binds only to loopback and rejects requests from unrelated browser origins. Set `APPLE_DEVICE_HUB_PREVIEW_PORT` to choose another port.

The browser UI uses React, shadcn/ui (Radix Nova), and Tailwind CSS. `components.json` configures the component source under `src/components/ui`. The build bundles React and the compiled CSS into the self-contained MCP HTML resource; no CDN or separate web server is needed in the host. Rebuild and reload the preview to pick up UI changes without restarting the preview backend.

`npm start` runs the local stdio MCP server; the root `.mcp.json` launches it for agents working in this repository. The plugin lives in `plugins/apple-device-hub`: edit its `plugin.json` for listing and review metadata and its `skills/` for agent guidance. The build generates `.codex-plugin/plugin.json` and the npx `.mcp.json` from `plugin.json` and the package version. Keep server diagnostics on stderr.

## Packages and releases

```sh
npm run build
npm run pack
npm run verify:packages
```

Archives are written to `release/`: the `apple-device-hub-mcp` npm package and `apple-device-hub-<version>.zip`, a self-contained copy of the plugin with its server bundled. Verification extracts each archive outside the checkout, initializes its MCP server, reads the viewer resource, checks all three host entrypoints and 20 tools, and verifies the arm64 native architecture and signing. It also checks that the Git plugin's marketplace, manifests and npx server version match the release, and that it contains no build output.

[CI](.github/workflows/ci.yml) runs type checks, tests, arm64 builds and archive verification on Apple Silicon macOS 26 with Node 22 and Node 24 for pull requests and changes to `main`. [Publish](.github/workflows/publish.yml) repeats release checks on macOS 26 for `v*` tags, requires the tag to match the package version and belong to `main`, publishes the MCP package with provenance using npm trusted publishing, and creates a GitHub release with archives and SHA-256 checksums. Stable releases use `latest`; prereleases use `next`. See [RELEASING.md](RELEASING.md) for setup and release commands.

## Boundaries

- Simulator video and live touch use private CoreSimulator screen and SimulatorKit HID APIs. A future Xcode change may require updating the helper; stream failures report their cause in the viewer, and live input falls back to Xcode. Physical-device video, multi-touch gestures, linked input replication, and KittyFarm's Build & Play workflow are outside this implementation.
- Xcode's own event handling sets the latency of agent actions and of viewer input without simulator video: taps take about 0.6 s, and hardware buttons such as Home can take about 5 s inside Xcode. The idle wait adds about 1 s on a still screen.
- Tap/swipe coordinates are logical points from the most recent native window hierarchy. Screenshot pixel dimensions can differ by the device's display scale.
- Only typed device actions and supported settings are exposed. Apple's session secret and local artifact paths stay server-side.
- A successful build or protocol inspection does not establish real-host rendering. Validate the app in ChatGPT separately from the standalone preview.
- Live capture updates the selected session and discovers a replacement after a session closes. Immediate host notification routing and screenshot attachment submission require host acceptance testing.

See [VALIDATION.md](VALIDATION.md) for the checks completed on this Mac and the remaining host and physical-device validation limits.
