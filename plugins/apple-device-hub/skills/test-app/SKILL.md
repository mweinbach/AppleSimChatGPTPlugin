---
name: test-app
description: Test the user's own iOS app on a simulator with Apple Device Hub — install a build, launch it, walk through a flow, check each screen against what should happen, and report what worked or broke with evidence. Use when the user asks to test, try, verify a change in, or reproduce a bug in their app.
---

# Test an app on a simulator

Follow the device-hub skill for connecting and for the observe → act loop.

## Get the app running

Test on a fresh simulator from `simulator_create` unless the user names one, so first-launch state is real and their own data stays untouched; delete it with `simulator_delete` afterwards.

Apple Device Hub does not build apps. If the app is not installed and you can run shell commands, build and install it for the connected simulator, using its `id` from `device_hub_status`:

```sh
xcodebuild -scheme <Scheme> -destination 'id=<simulator id>' -derivedDataPath build build
xcrun simctl install <simulator id> build/Build/Products/Debug-iphonesimulator/<App>.app
```

Find the bundle ID with `xcodebuild -scheme <Scheme> -showBuildSettings | grep PRODUCT_BUNDLE_IDENTIFIER`, then launch with `device_action` `{"type": "launchApp", "bundleId": "<id>"}`. To test a first launch, uninstall with `xcrun simctl uninstall <simulator id> <bundle id>` and install again.

## Walk the flow

1. Turn the request into short steps, each with the result you expect to see: a screen title, a label, a value, a button becoming enabled.
2. For each step, act, then compare the returned elements with the expected result. Pass `screenshot: "always"` when the result is visual, such as an image that loaded, a chart, or a layout. Record what you actually saw.
3. Reach off-screen rows by scrolling the list until the target appears in the elements. Type into fields with `simulator_type_text` and a `target`; finish with Return.
4. Alerts and permission prompts appear in the elements. Answer them deliberately, and ask the user about permissions that matter to the test.
5. When a step fails, relaunch and reproduce it once before reporting, and capture the failing screen with `screenshot: "always"` as evidence.

## Report

List each step as passed or failed. For a failure, give the expected result, the text and state actually on screen, and the step that led there. If the cause is visible in the project's code, point to it. Only say the flow works if the final screen shows it working.
