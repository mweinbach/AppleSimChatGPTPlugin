---
name: device-hub
description: View and control local Apple simulators and connected devices through Apple Device Hub in ChatGPT, including screenshots, accessibility inspection, device gestures, and appearance settings.
---

Use `open_device_hub` to show the viewer. The app is local: Xcode's Apple device bridge runs on the user's Mac.

The simulator viewer prefers continuous hardware HEVC when its WebCodecs decoder supports it, and automatically switches to H.264 if HEVC capture or decoding fails. Video is separate from accessibility observations. It runs during actions and stops when the viewer is hidden, Live is disabled, or the session is disconnected. Use `device_capture` to observe a particular screen for model reasoning; video frames are not sent to the model. Physical devices use screenshot refreshes.

1. List devices with `device_hub_status`, then connect a chosen device with `device_connect`. Starting a simulator session may boot it.
2. Capture the screen with `device_capture`. Coordinates use logical points in `coordinateSpace`, not image pixels. When accessibility inspection is enabled, choose positions from the latest hierarchy.
3. Use typed `device_action` inputs for tap, swipe, text, buttons, orientation, and opening the device Settings app. Every action returns the resulting screen.
4. `accessibilityEnabled` controls hierarchy visibility in the viewer and model output. It does not toggle VoiceOver or iOS accessibility settings. Disabling it avoids repeated hierarchy collection where native screenshot capture is available; an initial hierarchy may still establish coordinate space.
5. `device_settings` changes appearance, Dynamic Type size, motion, transparency, and contrast through Apple's supported tools. Captures include observed setting values when available. Use the Settings app for other controls or preferences unavailable through the installed Apple command-line tools.
6. Disconnect when finished. Idle sessions expire automatically. Do not leave costly device interaction sessions running without use.

For simulator computer use, the model also has dedicated tools resembling the host's computer-use interface. All require a public simulator `sessionId` from `device_connect` and reject physical-device sessions:

- `simulator_get_state`: observe a screenshot, numbered accessibility elements and the current snapshot.
- `simulator_screenshot`: screen-only observation in logical points.
- `simulator_click`: target `[x,y]`, an element number, an `e` ref, or an accessibility selector; `clickCount: 2` double clicks and `duration` holds a long press.
- `simulator_drag`: drag between logical `from` and `to` coordinate pairs.
- `simulator_scroll`: reveal content in a direction, optionally at a coordinate target or within an accessibility element.
- `simulator_type_text`: type literal Unicode text, optionally focusing a target first in the same serialized operation.
- `simulator_press_key`: Return, Tab, Backspace, Home, Lock, VolumeUp, VolumeDown.

Pass the latest `snapshot` for numeric targets or refs. Stale snapshots fail before input; observe again to obtain current refs. Each input returns the resulting screenshot and fresh elements. These observations do not change the viewer's accessibility preference. Unsupported keyboard shortcuts, mouse hover and desktop input are outside the simulator touch interface.

Device settings persist. Prefer reversible changes that serve the user's current testing task. The viewer's Attach screen button explicitly includes the current screenshot and any enabled hierarchy in the next message.
