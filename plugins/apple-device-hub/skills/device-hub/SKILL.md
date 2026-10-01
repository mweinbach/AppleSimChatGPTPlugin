---
name: device-hub
description: Drive Apple simulators and connected iPhones or iPads with Apple Device Hub — connect, read the screen and its accessibility elements, tap, type, scroll, press buttons, launch apps and change appearance settings. Use whenever the user asks to look at, use or control a simulator or Apple device.
---

# Apple Device Hub

The user watches the device in the Apple Device Hub viewer while you work: live video, plus the same element list you get. They can touch the screen themselves at any time. You see what the tools return: a numbered list of on-screen elements with tap points and sizes, and a screenshot sized in logical points when you need one.

## Connect

1. Call `open_device_hub` when the user wants to watch or hasn't opened the viewer.
2. Call `device_hub_status`. Reuse a session in `sessions` if one matches the device the user means; they may have connected in the viewer. Otherwise call `device_connect` with a device `id`. Connecting boots a stopped simulator and takes a few seconds.
3. Keep the session `id` for every later call.

## Observe, act, observe

Simulators use the `simulator_*` tools:

- `simulator_get_state` returns the numbered elements and a `snapshot` number. `simulator_screenshot` returns only an image.
- `simulator_click` takes a `target`: an element number (`12`) or ref (`"e12"`) with the `snapshot`, a selector such as `{"label": "General", "role": "Button"}`, or a point `[x, y]`. `clickCount: 2` double-taps; `duration` long-presses.
- `simulator_type_text` types literal text, focusing `target` first if given. `simulator_press_key` sends Return, Tab, Backspace, Home, Lock, VolumeUp or VolumeDown.
- `simulator_scroll` moves content in `direction` ("down" reveals what is below), optionally within an element. `simulator_drag` swipes between two points.

Physical devices use `device_capture` and `device_action`, for example `{"type": "tap", "element": {"ref": "e6"}}`. On any device, `device_action` also launches an app by bundle ID (`{"type": "launchApp", "bundleId": "com.apple.Maps"}`), opens Settings, rotates, and presses hardware buttons.

- Every input returns the screen after animations settle, with fresh elements. Read it before the next step instead of chaining inputs blind.
- Prefer elements to coordinates. Coordinates are logical points; in the default screenshot one pixel is one point.
- "Accessibility snapshot is stale" means the screen changed, possibly because the user touched it. Observe again and choose the target from the new list. Never guess a replacement.

## Screenshots

Results are text-first. With the default `screenshot: "auto"`, the element list describes the screen, and an image is attached only when the list can't, such as in games, maps, web content, or an empty or hidden list. Every observing and acting tool accepts:

- `"always"` when the answer is visual: layout, clipping, overlap, color, images, or confirming that something looks right.
- `"never"` to keep context small during a long scripted flow you are verifying through elements.

If the elements don't explain what you expected to find, take one screenshot rather than guessing.

## Settings

`device_settings` changes `appearance` (light or dark), `textSize`, `reduceMotion`, `reduceTransparency` and `increasedContrast`. Changes persist on the device. Note the original values from a capture's `settings` first, and restore them when you are done.

## Working alongside the user

- Say briefly what you are about to do; the user sees each step happen.
- Ask before actions that are hard to undo or act for the user: deleting data, purchases, sending messages, changing accounts. Hand sign-in, two-factor codes and system permission prompts to the user.
- Input only reaches the device, never the Mac desktop.
- Call `device_disconnect` when finished, unless the user is still using the viewer.

## Problems

- "Could not connect to Xcode MCP": ask the user to open Xcode and enable **Settings → Intelligence → Model Context Protocol**.
- "Xcode did not accept the connection" or "did not answer": Xcode may be showing a dialog, such as a request to allow access. Ask the user to check Xcode, then retry.
- "The device is still busy" or "did not finish": an earlier request is still running and its input may still land. Wait a moment and observe before repeating anything.
- "The device may still be starting": a simulator is booting. Observe again in a few seconds.
- A physical device that will not connect must be paired, unlocked and in Developer Mode; Apple decides eligibility when connecting.
- "Device session expired": connect again with `device_connect`.
