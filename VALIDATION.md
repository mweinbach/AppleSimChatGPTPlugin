# Validation evidence

This report records local development checks. Files referenced under `artifacts/`
are local validation outputs and are excluded from the public repository.

Validated on **2026-09-23**. The installed plugin's current identity and version are recorded in its [manifest](plugins/apple-device-hub/.codex-plugin/plugin.json).

## Environment

| Item | Observed value |
| --- | --- |
| Xcode | 27.2, build `27B5019j` |
| CoreDevice CLI | `devicectl` version `651.13.2`; appearance JSON version 5 |
| Simulator | iPhone 18 Pro Max, iOS 27.2 (`24B5084k`) |
| Simulator UDID | `DC1162A9-07D4-4147-A8CE-7DA001ED3B4C` |
| Development viewer | Loopback preview at `http://127.0.0.1:4319` |

## Automated and protocol checks

The latest `npm test` run passed **51 tests**, including native video framing, capability authorization and expiry, shared encoders, disconnect cleanup, Annex B decoding, backpressure, and frame disposal. `npm run typecheck` and `npm run build` passed. Source and installed plugin validation passed. The installed server advertises ten tools, including app-only `device_stream`, and the `global`, `thread`, and `settings` entrypoints with their referenced HTML resource.

These checks cover Apple JSON parsing, logical window bounds, literal keyboard encoding, private session keys, unique native session names, concurrent action serialization, accessibility suppression, observation retries without replaying actions, idle cleanup, settings contracts and reported values, orientation metadata, and MCP input/error handling. They are separate from the live preview and native bridge checks below.

## Live simulator and preview checks

The source `AppleHub` connected through its own MCP Client and `StdioClientTransport` to `xcrun mcpbridge`. It used Apple's workspace-free `DeviceInteractionStartSession`, `DeviceInteractionSynthesize`, and `DeviceInteractionEndSession`; no test application was installed.

| Check | Observed result |
| --- | --- |
| Native capture | PNG and root `Window` both measured **440 × 956**. The native hierarchy provided `hitPoint` coordinates. |
| Accessibility hidden | Subsequent refresh used screenshot-only `simctl` capture: **1320 × 2868** pixels, with logical `coordinateSpace` retained as **440 × 956**. The viewer and result omitted the hierarchy. |
| Viewer tap | A preview tap mapped to logical `(371, 465.3)` and opened `com.apple.Preferences`. |
| Literal keyboard | Native and source checks preserved two spaces, a literal backslash, and an emoji. Settings Search values included exactly `A  B \🙂` and `Source  \🙂`. Search text was cleared afterward. |
| Settings swipe | Source swipe `(220, 717)` to `(220, 239)`, duration `0.4s`, changed the Settings scroll indicator **0% → 100%**. The result persisted after another 750 ms. |
| Appearance | Preview controls changed **Light → Dark → Light**. Native reported values and the viewer followed the changes. |
| Reduce Motion | Preview controls changed **Off → On → Off** using the simulator-capable native appearance API. |
| Text size | Preview controls changed **Large → Small → Large**. Native reported values and the viewer followed the changes. |
| Narrow viewer | At **384 × 880**, page width remained **384** and viewer width was **352**; no horizontal page overflow was observed. The temporary viewport override was reset. |

The swipe's [before screenshot](artifacts/validation/before.png) shows General and Accessibility near the top. The [settled screenshot](artifacts/validation/settled.png) shows the scrolled list, including Privacy & Security, Apps, and Developer.

An earlier unchanged swipe targeted the active Search Suggestions overlay, which had no content to scroll. Apple's hierarchy still contained obscured rows from the main Settings list. Closing that overlay made the same source gesture path visibly scroll the main list; no gesture grammar change was required.

### Device orientation and portrait-locked content

A native `landscapeLeft` request produced these distinct headers:

```text
Device orientation: Landscape Left
Application UI orientation: Portrait
```

Settings and SpringBoard retained **440 × 956** screenshots and logical bounds. Screenshot aspect therefore cannot establish device sensor orientation. The capture now exposes the native device orientation separately, retains it for screenshot-only refreshes, and the viewer's Rotate control uses that value. Two preview Rotate clicks were verified to return **Landscape Left → Portrait** even with portrait-locked content.

All native sessions created for these verification runs were explicitly ended and their independent MCP bridges closed. Native end-session responses included `Session stopped`. The preview's test session was disconnected too. The simulator was left **Home + Portrait**, with **Light appearance, Reduce Motion off, Large text**, and empty search text. Settings retained its bottom scroll position.

## Physical-device result

Source discovery returned **Max’s iPhone 18 Pro — iOS 27.2**, with `state: "disconnected"` and `available: true`. That discovery record identified a paired candidate; it did not establish native interaction readiness.

The source's read-only physical connection attempt failed at `DeviceInteractionStartSession` before creating a session or capturing a screen. The first native error was:

```text
Cannot select specified device. To recover, pick from a list of eligible devices:
```

Apple listed only **11 simulators** as eligible, including the ready iPhone 18 Pro Max. No physical device appeared. Consequently, neither physical accessibility capture nor the direct physical `devicectl` screenshot path was live verified, and no physical dimensions are claimed. No physical device action, setting, app installation, permission change, or security change was performed. The independent MCP bridge was closed after the failed attempt.

## Native ChatGPT host boundary

The plugin was built and installed locally, and its protocol and standalone preview were verified. Initially, the user confirmed that the sidebar and settings entries appeared, but the panel showed **Failed to load**. Desktop logs at `2026-09-23T20:26:21.955Z` reported `-32603` and `unknown MCP server 'apple-device-hub'` for both `open_device_hub` and the `ui://apple-device-hub/viewer` resource read in the existing task. This occurs before loading the viewer HTML. The documented plugin pickup boundary is a new task; initial installation also calls for fully quitting and reopening the host. The subsequent host checks are recorded below.

The installed cache was independently launched and inspected: all eight tools, three entrypoint types, and the HTML resource passed protocol inspection. Its launch paths match the installed Bits & Bolts example. This verifies the installed server's startup and resource serving, separate from the existing host task's registry.

After reopening the host, the user confirmed that the viewer was running. The plugin's actual MCP tools became callable in this task. `device_hub_status` returned the viewer's existing session on the booted iPhone 18 Pro Max, and `device_capture` returned its native **440 × 956** screen and hierarchy. Chat-driven `device_settings` changed appearance **Light → Dark → Light**; `device_action` opened Settings, where separate captures visibly confirmed both themes. The restored Light capture was taken at `2026-09-23T20:42:02.560Z`. An accessibility-off capture omitted the hierarchy and returned **1320 × 2868** pixels with **440 × 956** logical coordinates. Accessibility was then restored to on and the device returned to Home. The user's existing session was retained. These calls verify the host's MCP-to-device path; sidebar DOM inspection and attachment submission remain separate limits.

The **Attach screen** flow inside the installed ChatGPT host remains unverified. Native computer use returned:

```text
Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.
```

The installed ChatGPT host uses that bundle identifier. The restriction was respected; no alternate UI-control path was used to bypass it. Build, installation, protocol inspection, live simulator control, and native-host rendering are distinct validation results.

## Session and accessibility synchronization update

Ordinary Live and manual captures now omit an accessibility override. Only an explicit checkbox change writes that preference. Every inventory result reconciles the selected session, and a visible, disconnected Live viewer checks for a session matching the selected device or the sole active session. Selection, typing, gestures, and hidden views pause background work.

Two standalone viewer instances sharing the real backend were tested on a separate **iPhone 18 Pro, iOS 27.2**, UDID `39040C56-852A-47E1-8327-49AE26DFDF80`:

- The second viewer adopted the active session and displayed its screen.
- Turning accessibility off in the first viewer caused the second viewer to hide its hierarchy and uncheck its toggle, preserving logical dimensions **402 × 874**.
- Disconnecting in the first viewer cleared the second viewer's screen and returned its connection control to Connect. Live remained enabled and checked while disconnected.
- Reconnecting in the first viewer caused the second viewer to adopt the replacement session, display its screen, and reflect its accessibility-on preference.

Both temporary viewer tabs were closed, the temporary native session ended, the preview process stopped, and the separate simulator was restored to **Shutdown**. The automated **20 tests** passed, strict typecheck passed, and the updated bundle built. The installed cache passed plugin validation and protocol inspection with a **774,399-byte** UI resource.

The original iPhone 18 Pro Max session expired while its viewer was inactive during this check. A replacement session was connected for the user's continued use. Its final native capture at `2026-09-23T20:50:04.288Z` confirmed **Home, Portrait, Light appearance, Large text, accessibility on**, with motion, transparency, and contrast reductions off. `open_device_hub` was called with this active session in its opening result. The synchronization changes were verified in the standalone viewers; the updated sidebar DOM remains unavailable to native computer use.

## Simulator video update — 2026-09-23, 21:56 UTC

Installed version: **`0.1.0+codex.20260923215615`**. The installed native helper's ad hoc signature verifies. Its HTML resource is **784,647 characters**, contains the video canvas, and declares the server's actual loopback WebSocket origin in `ui.csp.connectDomains`. `device_stream` and the physical-device `device_frame` are visible only to the app.

The original native helper uses CoreSimulator's primary screen port and IOSurface callbacks, creates owned video buffers, and encodes H.264 through VideoToolbox with at most two frames in flight. On the user's already booted **iPhone 18 Pro Max**, read-only capture measured:

| Output | Hardware encoder reported by VideoToolbox | Steady rate | First frame | SIGTERM exit |
| --- | --- | --- | --- | --- |
| 1320 × 2868, default full resolution | true | 30.00 fps | 287 ms | 69 ms, exit 0 |
| 882 × 1920, optional scaling | true | 29.99 fps | 288 ms | 37 ms, exit 0 |

The five-second full-resolution sample contains 143 complete H.264 records. FFmpeg decoded every frame at the expected dimensions; 105 decoded frame checksums differ. Blocked stdout and a closed output pipe also exit cleanly. The measured results and configuration events are saved in [simulator-video-native-validation.json](artifacts/validation/simulator-video-native-validation.json), with the [Annex B sample](artifacts/validation/simulator-video.h264) and [decoded frame checksums](artifacts/validation/simulator-video.framemd5).

Chromium **151.0.7922.34** and bundled WebKit both decoded the real stream in the standalone preview at port **4320**. The expendable **iPhone 18 Pro**, UDID `39040C56-852A-47E1-8327-49AE26DFDF80`, streamed **1206 × 2622** pixels. Chromium counted **90 decoded canvas draws in 3,003 ms**, with no JavaScript errors or simulator `device_frame` calls. Two viewers shared one native helper. Video continued through Open Settings, a canvas tap into General, and a swipe that moved the General list to its bottom. Disabling accessibility produced no hierarchy poll over six seconds while video continued. Live off froze the frame count; closing the final active viewer removed the helper. Simulated document visibility changes exercised the hidden-view cleanup path.

Safari rotation changed video to **2622 × 1206**. Touch showed “Updating screen orientation…” until the native window bounds refreshed to **874 × 402**; the settled canvas showed upright landscape content. Returning to portrait restored the portrait frame. Disconnect cleared the screen and released capture. Reconnect produced a different session and resumed video. At **384 × 880**, document width stayed **384 pixels**. Viewer images are saved as [video-viewer.png](artifacts/validation/video-viewer.png), [video-viewer-compact.png](artifacts/validation/video-viewer-compact.png), and [video-rotation-settled.png](artifacts/validation/video-rotation-settled.png).

All owned browser contexts and preview sessions were closed, the preview stopped, and the test iPhone 18 Pro returned to **Shutdown**. No simulator-stream helper remained. The user's original **iPhone 18 Pro Max** session `242625db-b54c-4ad0-a67b-611f5400ecd5` remained active with accessibility enabled. Native-host video rendering and attachment submission remain unverified; the current task retains its original MCP server, so a new task is needed to load the updated plugin.

## Stability, simulator computer tools, and public SDK — 2026-09-30

Installed version: **`0.1.0+codex.20260930163800`**. The dependency is now the public registry release **`@openai/mcp-extensions@0.1.0`**. Its [official release](https://github.com/openai/mcp-extensions/releases/tag/node-v0.1.0) was published September 29 at 17:18:13 UTC; npm published the package at 17:26:43 UTC. The former vendored early-access archive was removed. The viewer handles hosts that do not advertise the SDK's optional model-context capability, using the standard MCP Apps context API when available.

The full source suite passed **108 tests**, with no failures, skips, or cancellations. Typecheck and the final build passed. After removing the obsolete loopback CSP declaration, all **11 MCP tests** and typecheck passed again. [Automated results](artifacts/validation/2026-09-30/automated.json) record the full-suite run. [Installed protocol inspection](artifacts/validation/2026-09-30/installed-protocol.json) passed with **19 tools**, global/thread/settings entrypoints, and a valid viewer resource. Source and installed server, browser bundle, stylesheet, native helper, SDK license, and skill bytes matched by SHA-256. The installed helper's ad hoc code signature verifies.

### Streaming transport and live validation

The production desktop host rejected the previous `ws://127.0.0.1` stream at its CSP boundary. The host log at `2026-09-30T16:24:13.349Z` records the rejection. The embedded viewer now carries native H.264 access units through app-only MCP tools; video bytes are confined to result metadata. Standalone preview retains direct WebSocket playback, and `?transport=mcp` uses the same relay and player as the embedded viewer. Reading the embedded HTML resource no longer starts a WebSocket listener or advertises a loopback network domain.

On the already running **iPhone 18 Pro, iOS 27.2**, UDID `39040C56-852A-47E1-8327-49AE26DFDF80`, the packaged server's real `device_stream_read` calls returned **144 encoded frames in 33 batches over 5,037 ms**, including startup; the first batch with frames arrived after **305 ms**. The measurements and encoded sample are saved in [relay-sample.json](artifacts/validation/2026-09-30/relay-sample.json) and [relay-sample.h264](artifacts/validation/2026-09-30/relay-sample.h264). These measurements describe transport delivery, not a browser's measured render rate.

Native Chrome visibly rendered the relay canvas, followed Home navigation from App Library to the Home screen, and resumed rendering after Live was paused. Pausing removed the native capture helper; resuming created a new helper. The final rebuilt viewer also rendered the relay, released its helper when its browser tab was hidden, and resumed rendering when shown again. Open Settings visibly changed the live canvas while video remained active; the [final viewer screenshot](artifacts/validation/2026-09-30/relay-viewer.jpg) records that state. Its device coordinates remained **402 × 874 logical points**. The displayed “30 fps” is the configured stream rate, not a measured browser frame counter.

Decoder batches wait for dequeue so a large batch cannot discard its own keyframe. Automated regressions cover a 30-frame batch, late responses after stop, scoped relay results, exactly-once cleanup, native framing, backpressure, startup failure, Retry, and session shutdown.

### Simulator computer tools

The model and app can use `simulator_get_state`, `simulator_screenshot`, `simulator_click`, `simulator_drag`, `simulator_scroll`, `simulator_type_text`, and `simulator_press_key`. These accept a public simulator session ID. Input targets use logical coordinates, accessibility selectors, or numbered element references. References require the observation's snapshot. Snapshot-protected actions refresh native state inside the serialized operation before validating the reference, so external navigation and rotation reject stale input before sending it. Input failures do not replay actions. Physical sessions are rejected by these simulator-specific tools.

The packaged server's live tools were exercised on that simulator:

| Check | Observed result |
| --- | --- |
| Type into a selected field | Settings Search received `stabilityabc`. |
| Backspace | Search changed to `stabilityab`; [capture](artifacts/validation/2026-09-30/3-simulator_press_key.jpg). |
| Stale reference | Click returned `Accessibility snapshot is stale` before sending input; [result](artifacts/validation/2026-09-30/3-simulator_click.json). |
| Selector click | Cleared Search and closed its overlay. |
| Scroll and drag | Settings scrolled down, then returned to its upper rows; [scroll capture](artifacts/validation/2026-09-30/6-simulator_scroll.jpg), [drag capture](artifacts/validation/2026-09-30/7-simulator_drag.jpg). |
| Screenshot | Returned a **402 × 874** image without an accessibility hierarchy; [result](artifacts/validation/2026-09-30/9-simulator_screenshot.json). |
| Home key | Returned to SpringBoard; [capture](artifacts/validation/2026-09-30/10-simulator_press_key.jpg). |

The current chat still has the previous MCP tool catalog. The updated embedded viewer requires a new chat to load the installed package. Its new transport is verified against the real native stream and the final standalone viewer; updated native-host rendering and screen attachment submission remain unverified in this chat.

## Hardware HEVC and H.264 fallback — 2026-09-30

Installed version **`0.1.0+codex.20260930203800`** retains public
`@openai/mcp-extensions` **0.1.0**. The viewer checks HEVC WebCodecs support,
requests a hardware-required HEVC Main encoder when supported, and switches once
to H.264 on capture or decoder failure. Fallback persists for the connection;
explicit Retry or a new connection permits another HEVC attempt. H.264 retains
its hardware-preferred Baseline configuration. Both use 30 fps, no frame
reordering, and a one-second keyframe interval. HEVC's target bitrate is 60% of
H.264's target. The Annex B parameter-set and keyframe rules follow the
[W3C HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/).

The final suite passed **118 tests**, with no failures or skips. Typecheck and
build passed. Added checks cover real CoreMedia HEVC parameter sets with 1-,
2-, and 4-byte NAL lengths, RFC 6381 identity extraction, HEVC decoding startup,
mixed-codec encoder ownership, capture and decoder fallback, and cancellation
during capability negotiation. [Full test output](artifacts/validation/2026-09-30/hevc-tests.txt)
and [installed protocol inspection](artifacts/validation/2026-09-30/hevc-installed-protocol.json)
record the results. The installed server exposes 19 tools and the three host
entrypoints. Source and installed package files match by SHA-256, and the
installed native helper's ad hoc signature verifies.

Live checks used iPhone 18 Pro, iOS 27.2,
**`39040C56-852A-47E1-8327-49AE26DFDF80`**, at **1206 × 2622** encoded pixels and
**402 × 874** logical points. The device was booted again after it shut down
before the first capture attempt. Native hardware diagnostics and measurements:

| Codec | Hardware | Frames | Measured fps | First frame | Encoded bytes |
| --- | --- | --- | --- | --- | --- |
| HEVC Main, `hev1.1.6.L150.B0` | Yes | 158 | 30.28 | 294 ms | 2,000,883 |
| H.264 Baseline, `avc1.420032` | Yes | 158 | 30.27 | 296 ms | 3,617,097 |

The samples each ran for approximately 5.5 seconds on the static Home screen.
HEVC used **44.7% fewer bytes per frame** with the configured bitrates. This
does not establish equal visual quality or predict bandwidth for animated apps.
The [HEVC diagnostics](artifacts/validation/2026-09-30/native-sample-hevc.json)
and [H.264 diagnostics](artifacts/validation/2026-09-30/native-sample-h264.json)
include the VideoToolbox hardware flag. `scripts/video-benchmark.mjs` reproduces
these native measurements against a booted simulator.

The actual MCP relay separately delivered **138 HEVC frames / 1,682,785 bytes**
over 5.07 seconds and **142 H.264 frames / 2,928,777 bytes** over 5.02 seconds.
Native Chrome visibly rendered **“Live video · HEVC · 30 fps”** through
`?transport=mcp`; the [HEVC viewer screenshot](artifacts/validation/2026-09-30/hevc-viewer.jpg)
records that canvas. The label reports the configured rate, not measured browser fps.

`scripts/video-fallback-preview.mjs` then rejected only HEVC capture with
“Hardware HEVC unavailable (validation fixture).” The same built viewer
automatically opened the real H.264 helper and visibly rendered
**“Live video · H.264 · 30 fps”**; the
[fallback screenshot](artifacts/validation/2026-09-30/h264-fallback-viewer.jpg)
records the result. This tests the failure path without altering production codec
selection or the installed helper. Decoder rejection and unsupported HEVC
capability are additionally covered by the automated viewer tests.

Both preview sessions were disconnected, their servers and validation bridge
were closed, the validation Chrome window was closed, and no capture helper
remained. Temporary simulator defaults were cleared. The simulator was left
booted on Home. The updated embedded Codex viewer still needs a new chat to pick
up this package; native-host HEVC rendering and attachment submission remain
unverified in this existing chat.

All validation sessions were disconnected, owned preview/probe processes and the owned browser tab were closed, and no native streaming helper remained. The simulator was left booted after returning it to Home; its appearance settings and empty search text were retained.

## npm distribution and macOS 26 CI — September 30, 2026

Release **0.1.2**, commit **`88917ec81083f81bac8e99a7915cfcad9fdfdb9c`**,
publishes two separate packages: `apple-device-hub-mcp` for standalone clients,
and `apple-sim-chatgpt-plugin` containing the plugin manifest, skills, installer
and a copy of the same MCP runtime. Both packages restrict npm installation to
Apple Silicon Macs and include a signed arm64 capture helper. No compilation or
runtime npm dependency installation is needed on the user's machine.

- [CI run 36777294749](https://github.com/mweinbach/AppleSimChatGPTPlugin/actions/runs/36777294749)
  passed on the `macos-26` arm64 runner with Node 22 and Node 24. Each job passed
  type checks, all **118 tests**, the native build, package creation and archive
  verification. CI uploads both built package archives.
- [Publish run 36777298306](https://github.com/mweinbach/AppleSimChatGPTPlugin/actions/runs/36777298306)
  passed on **macOS 26.6.2**, Node **24.20.0**, npm **11.19.0**. It checked the tag
  and `main` ancestry, repeated the build/tests/package verification, published
  both packages using their configured GitHub trusted publisher, and created
  [release v0.1.2](https://github.com/mweinbach/AppleSimChatGPTPlugin/releases/tag/v0.1.2)
  with both archives and `SHA256SUMS`. No npm token is stored in GitHub.
- npm registry metadata confirms **`latest = 0.1.2`**, **`cpu = ["arm64"]`** and
  SLSA provenance attestations for both packages. The registry initially returned
  404 while processing the CI publications; availability was checked again after
  processing completed. Both `npx --yes <package>@latest --version` commands
  return **0.1.2**.

Archive verification extracts each tarball to a temporary directory outside the
checkout, launches its bundled MCP server from an unrelated working directory,
checks all **19 tools** and the `global`, `thread` and `settings` entrypoints,
and reads the self-contained viewer HTML. It verifies the native binary's arm64
architecture and signature, confirms both packages contain identical runtime
bytes, confirms the standalone package excludes plugin metadata and skills, and
checks that the plugin includes those files. The installer test uses a fixture
`codex` executable to verify persistent copying, marketplace registration,
reinstallation and command-failure propagation. The actual host's existing local
marketplace also accepted repeat registration. This distribution check does not
claim a fresh ChatGPT render or device interaction from the npm-installed plugin.

## Gallery preparation and release 0.1.3 — September 30, 2026

Release **0.1.3**, commit **`d58447e2c6a2374853cbf40e0bba4ce03f3db99f`**,
adds portable Agent Plugins `plugin.json` and `mcp.json`, generates the legacy
manifest from that source, supplies listing and review metadata, and builds a
complete plugin ZIP alongside the two npm packages. Tool annotations now disclose
stateful video start/stop and potentially destructive/open-world device input.

- [CI run 36779804575](https://github.com/mweinbach/AppleSimChatGPTPlugin/actions/runs/36779804575)
  passed on macOS 26 with Node 22 and Node 24. Each job passed type checking,
  native build, **118 tests**, both npm archive checks and extracted ZIP checks.
- [Publish run 36779979876](https://github.com/mweinbach/AppleSimChatGPTPlugin/actions/runs/36779979876)
  passed, repeated those checks, published both npm packages through trusted
  publishing with provenance, and created
  [release v0.1.3](https://github.com/mweinbach/AppleSimChatGPTPlugin/releases/tag/v0.1.3)
  with both tarballs, `apple-device-hub-0.1.3.zip` and `SHA256SUMS`.
- The downloaded release ZIP matches its published SHA-256 checksum:
  `22772a16ae96564552d98fe734ed053444092d3e8742dc5e32875075a8e277c0`.
  It is **600,591 bytes**, well below the documented 100 MB upload limit.

The ZIP probe launches the extracted portable MCP configuration without source
dependencies, discovers **19 tools**, verifies the `global`, `thread` and
`settings` entrypoints, reads the self-contained HTML, checks listing lengths and
five positive/three negative review cases, compares its runtime bytes with the
standalone build, and verifies the native helper's ad-hoc signature. The native
helper is not Developer ID signed or notarized.

This is local packaging/protocol evidence. The new review cases have not been
completed end-to-end in an approved gallery host. Installed-host rendering and
attachment acceptance, a public walkthrough, starter-prompt screenshots,
publisher identity, final public terms, and OpenAI's local-MCP distribution
decision remain separate requirements in the
[submission packet](docs/gallery/SUBMISSION.md). No gallery submission or
publication was performed.

## 60 fps video and live simulator input — September 30, 2026

Unreleased source after v0.1.3. Measured on the booted **iPhone 18 Pro, iOS 27.2**,
`39040C56-852A-47E1-8327-49AE26DFDF80`, with Xcode 27.2 (`27B5019j`) and headless
Google Chrome **154.0.8037.58**. Before this change the helper sampled a fixed
30 fps timer, each relay read waited 150 ms, and viewer input went through Xcode
as one tap or swipe after pointer release.

CoreSimulator's frame callback fires only when the simulator renders a changed
frame: none on a static Home screen, and a median interval of **16.6 ms** (p95
19.1 ms) during a sustained drag. SimulatorKit's `SimDeviceLegacyHIDClient`
accepted Indigo touch packets in **0.06 ms** on average, and the first changed
pixels followed about **65 ms** after the first touch. The HID Home button
returned from Settings to the Home screen. `scripts/interaction-benchmark.mjs`
drove a 2.8-second HID drag through the helper's own input channel:

| Codec | Encoded size | fps | Interval p50 / p95 | Bandwidth | Touch → frame |
| --- | --- | --- | --- | --- | --- |
| HEVC | 1206 × 2622 | 61.7 | 16.4 / 20.9 ms | 17.8 Mbps | 65–80 ms |
| H.264 | 1206 × 2622 | 62.9 | 16.2 / 21.1 ms | 28.9 Mbps | 78–91 ms |
| HEVC | 706 × 1536 | 62.6–62.9 | 16.3 / 18.8–19.9 ms | 6.8–7.1 Mbps | 46–65 ms |
| H.264 | 706 × 1536 | 62.3 | 16.1 / 21.0 ms | 12.5 Mbps | 57–82 ms |

Average encode latency was 4–6 ms at 706 × 1536 and 9–11 ms at full resolution.
A static screen produced one keyframe and one refresh per second.

The built viewer ran in Chrome through the preview's `?transport=mcp` relay, the
same tool-call path as the embedded host. Its canvas displayed 229 × 498 CSS
pixels at 2× and requested **470 × 1024** video. Playwright pointer events drove
five short drags, a 300-step drag at about 120 Hz, and the Home button:

| Codec | Drag fps (5 s window) | Touch → drawn frame | `device_input` round trip | Relay bandwidth | Home → first frame |
| --- | --- | --- | --- | --- | --- |
| HEVC | 56.9 | 77–93 ms | 1.5 ms average | 6.8 Mbps | 239 ms |
| H.264 | 57.3 | 81–84 ms | 1.6 ms average | 10.6 Mbps | 418 ms |

The drag window includes the gesture's start and the automation's own load on the
page. With the same drag sent from Node through `device_input`, the viewer drew
**61.1–61.7 fps** with interval p50 16.3–16.6 ms and p95 19.4–20.6 ms, matching
the helper's own spacing.

Chrome's hardware H.264 decoder held **9–10 frames** of VideoToolbox's Baseline
stream, whose SPS has no VUI, and released them in bursts at keyframes. With the
server's `declareH264DecodeOrder` rewrite it held **none**, and all 118 decoded
pictures hashed identically to the original stream. Software decoding held no
frames either way. After the rewrite every H.264 frame was drawn 2–4 ms after its
batch arrived. Homebrew FFmpeg could not start on this Mac (missing
`libx265.216.dylib`), so this decode check used WebCodecs.

In landscape Safari, video restarted once at 1920 × 882 after rotation. A live tap
at frame fraction (0.500, 0.966) opened iana.org's “Learn more” link, and a tap at
(0.108, 0.080) pressed Back and returned to example.com, confirming both axes of
the rotated touch mapping. The simulator was returned to portrait and Home.

The installed host, ChatGPT **26.928.20755** (`com.openai.codex`), was inspected
rather than run. Its MCP app bridge dispatches each iframe request asynchronously.
Its app-server scheduler admits at most three non-critical requests per MCP app
in a conversation, four per conversation, five across the app, and eight in
total; app tool calls run as `interactive`. The viewer therefore keeps one video
read pending, leaving capacity for live input and accessibility observations.

The source suite passed **127 tests**. Typecheck, build, pack, and
`verify:packages` passed with **20 tools**. Rendering in the ChatGPT host still
needs a plugin reinstall and a new chat, and was not performed here.

## Text-first observations, bounded calls, and short host windows — September 30, 2026

Measured through the built MCP server on a separate **iPhone 17, iOS 27.2**
simulator, `0E862866-8D31-478E-9DB6-3B8217406EB2`, so the user's own simulator
was not touched.

| Call | Time | Result |
| --- | --- | --- |
| `simulator_get_state` (`screenshot: "auto"`, 21 elements) | 324 ms | 1.7 KB of text, no image |
| `simulator_get_state` (`screenshot: "always"`) | 333 ms | text and a 58 KB JPEG |
| `simulator_click` on Settings, settled | 3.3 s | text only |
| `simulator_scroll`, settled | 2.9–3.0 s | text only |
| `simulator_press_key` Home, settled | 6.9 s | text only; Xcode's Home is slow |

Xcode's `DeviceInteractionStartSession` returned in 48 ms for a shut-down
simulator; its first observation then took 9.2 s while the device booted. One
run reported a hierarchy without window bounds just after boot, and the next two
observations failed the same way. Observations now retry three times and keep
the previous coordinate space when the hierarchy has no window and the image
keeps its shape; a window of another shape still rejects. Xcode requests time out
after 40 s (100 s for the booting observation), and a request returns within
55 s, even when queued behind a stuck one, without sending its input later.

Codex loads this plugin through its root Agent Plugins `plugin.json`, whose
`mcp.json` schema rejects unknown keys: adding `startup_timeout_sec` there made
`codex mcp get` stop listing the server, and the `.codex-plugin` overlay only
merges environment variables. Codex's own defaults, a 30 s startup and 300 s tool
timeout (`codex-rs/codex-mcp/src/rmcp_client.rs`), already cover the first `npx`
download and every bounded call, so the plugin sets no timeouts.

The viewer was checked in headless Chrome at the user's ChatGPT window size,
**840 × 490**, with a 56 px bottom safe-area inset and a 350 × 44 composer drawn
at the bottom right, plus 700 × 560, 420 × 880 and 1360 × 860, in light and dark.
At 840 × 490 the device rendered about 410 px tall, the controls sat in the top
bar, the Elements and Appearance column ended above the inset, and nothing
interactive sat under the composer. The suite passed **132 tests**.

## Shared sessions, spawned simulators, and model-visible results — September 30, 2026

Probed against Xcode 27.2's bridge on the separate iPhone 17 simulator:

- **One session per device.** A second `DeviceInteractionStartSession` failed with “The target device is already in use by a different session with key '<name>'”.
- **Keys are names.** The key is exactly the `sessionIdentifier` passed in. It worked from another bridge connection, and after the creating connection closed, so a session outlives the server that started it.
- **Ending.** `EndSession` with that name ended it. A name cannot be reused right away, and a call on an ended session reports “Session not found”.
- **Error format.** Errors arrive as text content shaped like `{"type":"error","data":"…"}`.
- **Simulators.** `simctl create` took about 1 s; `simctl clone` refuses a booted source.

Codex's `CallToolResult::as_function_call_output_payload`
(`codex-rs/protocol/src/models.rs`) gives the model only the serialized
`structuredContent` when a result has one. Capture results had carried their
state there, so a Codex model received the session, coordinate space and snapshot
number but neither the element list nor the screenshot. Results the model reads
now return text and images only, with the viewer's state in `_meta`.

Two built servers, standing in for two chats, plus a raw bridge client standing in for another tool, ran these checks:

| Check | Result |
| --- | --- |
| Server B connects a device server A holds | Joined A's session in 518 ms; B observed the screen |
| A disconnects | B kept observing; B's disconnect then ended the session |
| Server C connects, then is killed with `SIGKILL` | B adopted C's session and ended it on disconnect |
| Another tool holds the device | Refused without `takeOver`; joined with it; the other tool's session stayed open after B left |
| `simulator_create` with `deviceType: "iPhone 17 Pro"` | Created, booted and connected in 17.5 s; observed in 1.4 s |
| `simulator_delete` | Deleted the created simulator in 3.9 s; refused the user's iPhone 17 |

In headless Chrome, a viewer served by one server followed a model working through another server. The model's `simulator_create` moved the viewer to the new simulator, and its `device_connect` moved the viewer back in 1.1 s. Deleting the created simulator left the viewer on the iPhone 17. A viewer opened later from a third server joined the device the model held in 1.3 s. Registry entries are discarded after a reboot, and viewers follow only focus changes made after they open, so a stale focus cannot boot a device. The suite passed **143 tests**.
