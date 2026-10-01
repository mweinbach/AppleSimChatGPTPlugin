# Apple Device Hub gallery submission packet

Prepared September 30, 2026 against OpenAI's [package guide](https://developers.openai.com/plugins/build/plugins), [submission guide](https://developers.openai.com/plugins/deploy/submission), [submission error reference](https://developers.openai.com/plugins/deploy/submission-errors), and [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).

## Distribution route

This is a **local stdio MCP plugin for an Apple Silicon Mac**. Its value depends on the user's installed Xcode, local CoreSimulator display surfaces and paired physical devices. A centrally hosted HTTPS server cannot access those resources. The public submission guide directs local MCP developers who cannot deploy a remote endpoint to their OpenAI contact for local MCP support. Request that review route before attempting a normal portal submission.

The current ZIP is a complete local plugin review artifact. It is not eligible for the standard remote-MCP flow without OpenAI's local-MCP support. Do not use a skills-only upload: that path excludes MCP configuration, and adding MCP to an existing skills-only plugin is not supported. Do not replace the server URL with a loopback address or a tunnel to a user's devices.

Use [LOCAL-MCP-REQUEST.md](LOCAL-MCP-REQUEST.md) as the prepared request to your OpenAI contact. It has not been sent. The standard [Plugins dashboard](https://platform.openai.com/plugins) is where supported public submissions are managed; a dashboard upload is not a gallery publication.

## Build and package

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run pack
npm run verify:packages
```

`release/apple-device-hub-<version>.zip` contains a single plugin at the archive root, with:

- Portable `plugin.json` and `mcp.json` using Agent Plugins 1.0.0 schemas.
- Generated `.codex-plugin/plugin.json` compatibility metadata and local `.mcp.json` wiring.
- The exact same bundled MCP server, viewer and signed arm64 native helper as the standalone npm package.
- The device-hub skill, listing icon, ESM package metadata and third-party SDK license notice.

The native helper currently uses an ad-hoc code signature, verified by CI. It is not Developer ID signed or notarized; confirm the local-MCP review route's signing requirements before gallery distribution.

The packer uses an explicit file allowlist. It excludes source, development dependencies, local device evidence, authentication files and reviewer credentials. CI builds and probes the extracted ZIP as well as both npm archives on macOS 26 with Node 22 and 24. Tagged releases attach all three archives and their SHA-256 checksums to GitHub Releases. npm packages and local marketplace installs remain separate from gallery publication.

Edit `plugins/apple-device-hub/plugin.json` for listing and review changes. The build regenerates the legacy manifest; do not edit its generated copy. `npm version` synchronizes package and plugin versions.

## Listing already supplied

The portable manifest contains the display name **Apple Device Hub**, subtitle **Test Apple devices with Xcode**, publisher **Max Weinbach**, capabilities, accurate local-platform requirements, three starter prompts, a square SVG icon, website/support/privacy URLs, five positive cases, three negative cases and release notes. It explicitly identifies the plugin as independent of Apple.

The public [privacy and data-handling document](../PRIVACY.md) describes the actual implementation. Its public GitHub URL becomes accessible after the corresponding commit is pushed. The selected verified developer identity in the portal must match the publisher; manifest text does not verify identity.

## Items to finish with the local-MCP reviewer

| Item | Current status | Next action |
| --- | --- | --- |
| Local MCP distribution and supported surfaces | Requires OpenAI partner decision | Confirm local stdio/native executable support and allowed host/platform targeting. |
| Publisher identity and organization access | Not checked in this preparation | Select the owning organization/project and complete individual or business verification; owner or Apps Management Write is required. |
| Terms and distribution rights | Existing package remains `UNLICENSED`; no new license or legal agreement has been adopted | Finalize public usage/license terms and add the actual HTTPS `termsOfServiceURL` to the listing. |
| Installed host acceptance | Protocol and archive checks pass; latest installed rendering/attachment behavior is not established by those checks | Run [REVIEWER-RUNBOOK.md](REVIEWER-RUNBOOK.md) in a fresh chat on the approved host. |
| Five positive and three negative cases | Cases are in the ZIP; an end-to-end reviewer run is still required | Record actual results, tool calls and failures using the runbook. |
| Walkthrough URL | Not provided | Record the real host workflow and publish an accessible recording; add `review.demo_recording_url`. |
| Starter-prompt screenshots | Not provided | Capture the real host UI for each of the three prompts; provide one PNG/JPEG per prompt, exactly 706 pixels wide and 400–860 pixels tall, if the approved submission flow requires them. |
| Countries and attestations | Not selected or accepted | Choose availability and complete the dashboard's policy attestations as the publisher. |
| Apple private simulator capture API | Implementation uses CoreSimulator display surfaces; compatibility is not guaranteed | Disclose the helper to the reviewer and demonstrate fallback behavior on the target Xcode/macOS version. |

No review submission, publication, verified identity, demo credentials or platform-wide compatibility is claimed by this packet. The plugin needs no publisher account or OAuth credentials. Reviewer hardware, Xcode and local sample devices are required; use sample data rather than personal device content.

## Annotation rationale

All 22 MCP tools advertise explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` booleans. The current guidelines say annotation justifications are no longer required, while the submission-error page still lists them; this rationale is available if the portal/reviewer asks.

| Tools | Rationale |
| --- | --- |
| `open_device_hub`, `device_hub_preferences`, `device_hub_status`, `device_capture`, `device_frame`, `device_stream_read`, `simulator_get_state`, `simulator_screenshot` | Observe state or present/read the local viewer; no direct destructive action or arbitrary external destination. Temporary processing and session bookkeeping are internal. |
| `device_connect`, `device_stream`, `simulator_create` | Start stateful sessions/video jobs or create a local simulator, so not read-only. These create resources without deleting user data and remain scoped to local devices; joining another tool's device session requires an explicit `takeOver`. |
| `simulator_delete` | Deletes a simulator and its data, so marked destructive. Limited to simulators Device Hub created. |
| `device_stream_stop`, `device_disconnect` | Cancel/release stateful resources and revoke capabilities, so not read-only and marked destructive; destinations remain local and session-bound. |
| `device_settings` | Overwrites persistent device preferences, so not read-only and marked destructive. Limited to enumerated settings on the connected device. |
| `simulator_scroll` | Changes the visible scroll position, so not read-only. The operation does not submit app data or delete it. |
| `device_action`, `simulator_click`, `simulator_drag`, `simulator_type_text`, `simulator_press_key` | Device input can activate destructive controls, overwrite text, send messages, or submit information in arbitrary apps. Marked write/destructive/open-world even though input is physically scoped to a local device. |
