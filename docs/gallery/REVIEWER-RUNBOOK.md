# Apple Device Hub reviewer runbook

Use a dedicated sample simulator on an Apple Silicon Mac. Record the release version, host name/build, macOS version, Xcode version and simulator runtime. Run the five positive and three negative cases from `plugin.json` in a fresh chat after installation. Existing [VALIDATION.md](../../VALIDATION.md) documents earlier direct-MCP and standalone-viewer evidence; it is not an end-to-end gallery acceptance result.

## Setup

1. Install Xcode 27, open it and enable **Settings → Intelligence → Model Context Protocol**. Complete Apple's normal device/simulator setup.
2. Install Node 22+ and the desktop host's `codex` CLI. Install the release with `npx --yes apple-sim-chatgpt-plugin@<version> install`, or use the partner-approved ZIP installation route.
3. Restart the host and start a fresh chat. Confirm the loaded version and 19 MCP tools. Open the global viewer and the settings entrypoint, and open the task viewer from `open_device_hub`.
4. Use a sample iPhone simulator without personal accounts. Keep the current appearance value available so the setting test can restore it. Physical devices are optional acceptance coverage, not required for the simulator cases.

## Record each case

For every prompt, capture the actual tools and inputs, expected versus observed behavior, the visible viewer/screenshot, and any first error. Record **pass**, **fail**, or **not run**. Do not count a test-fixture pass as a live host pass.

The five positive cases cover inventory, connection/observation, element navigation, reversible appearance comparison and live video/disconnect. For the last case, explicitly exercise the viewer's Live toggle: the model does not call app-only video tools. Confirm that stopping/disconnecting releases native resources and that video bytes are not present in model-visible tool content. Exercise H.264 fallback separately when HEVC is unavailable.

The negative cases cover unsupported Mac desktop input, unavailable remote device access and stale snapshots. The stale-snapshot case also requires a direct protocol check: capture a simulator snapshot and a current element ref, navigate to a different screen, then call `simulator_click` with the old snapshot. Expect an error before input. Ask the model to observe again. The other two cases test model behavior and truthful capability boundaries.

## Recording and images

Record the installed host opening the viewer, connecting, observing elements, navigating, changing/restoring appearance, streaming and disconnecting. Include negative cases and show explicit errors or refusals. Use only sample simulator data. Publish a reviewer-accessible walkthrough URL and place it in `extensions.com.openai.review.demo_recording_url` in the portable manifest.

Capture each starter prompt's actual UI in the approved host. The documented portal format is one PNG/JPEG per prompt, exactly 706 pixels wide and 400–860 pixels tall. Add the files under `assets/` and list their paths in `interface.screenshots` after the local-MCP reviewer confirms that flow. Do not label standalone browser or simulator-only images as installed-host screenshots.

Check the Attach current screen action independently: add, submit and remove its context in the real host. If it is unsupported or fails, report that limitation before claiming the feature in a demo. Mobile/web/cloud operation is not currently supported or established for this local hardware plugin.

## Final handoff

Finalize the public terms URL, confirm website/support/privacy pages are reachable and publisher-consistent, select verified identity and availability, then rebuild and verify a new-version ZIP. Keep private reviewer access information out of the ZIP and enter it only in the approved secure review form. Complete platform attestations as the publisher and submit through the route OpenAI confirms for local MCP. Only publish after approval.
