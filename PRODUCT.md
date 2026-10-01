# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

App developers building for iPhone and iPad who use an AI agent in the ChatGPT desktop app (Codex) to test and drive their app on a simulator or connected device. The agent usually drives; the developer watches the device next to the chat and occasionally takes over to tap, type, or press Home. Confirmed by the maintainer, September 30, 2026.

## Product Purpose

Apple Device Hub lets an agent and a developer share one live Apple device inside the chat: the agent observes and acts through MCP tools, and the developer sees the same device live and can intervene immediately. Success is that the developer trusts what the agent did because they watched it happen, and can step in without leaving the chat.

## Positioning

It runs entirely on the developer's Mac against Apple's own Xcode device bridge and the simulator's native display and input, so the live picture and the agent's actions are the same device, in real time, with no cloud relay.

## Operating Context

- The viewer is mostly open in the host's narrow side panel beside a chat; fullscreen and wide panels also occur. Confirmed.
- The model never sees the video. It sees screenshots sized in logical points and a numbered list of accessibility elements (`e1`, `e2`, …) it acts on.
- Developers should be able to see what the model sees: an overlay of the element refs on the live screen, toggled on demand and off by default. Confirmed.
- Typical tasks: walk a flow in the developer's app, reproduce a bug, check accessibility labels, compare light/dark and Dynamic Type sizes.

## Capabilities and Constraints

- Simulators: live 60 fps video, live touch and Home through the simulator's HID path; Lock, rotation, typing and settings through Xcode.
- Physical devices: screenshot refreshes and Xcode input only.
- Device settings changes (appearance, text size, reduce motion/transparency, increased contrast) persist on the device.
- Attaching the current screen to the next chat message depends on host support.
- The UI is one self-contained HTML resource rendered in the host's iframe; host theme variables are applied when provided.

## Product Principles

1. The device is the interface; everything else gets out of its way, especially in the side panel.
2. Show the developer what the agent sees and did, in the agent's own terms (element refs), so its narration can be checked against the screen.
3. Taking over is immediate: touching the screen just works, with no modes to enter first.
4. Never claim a state the device has not reported; unknown settings stay unknown.

## Accessibility & Inclusion

The viewer itself must be keyboard-operable with visible focus and labelled controls, and respect reduced motion. The product also serves accessibility testing, so its element views use the same labels and roles VoiceOver reads.
