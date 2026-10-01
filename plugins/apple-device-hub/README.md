# Apple Device Hub plugin

View and control Apple simulators and connected devices from ChatGPT on your Mac. The plugin contains:

- `skills/` — how the agent drives a device, tests an app, and reviews accessibility.
- `.mcp.json` — starts the `apple-device-hub-mcp` server of the same version with `npx`.
- `.codex-plugin/plugin.json` and `plugin.json` — manifest, listing and review metadata.

Requires an Apple Silicon Mac, macOS 14+, Node 22+, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled.

```sh
codex plugin marketplace add mweinbach/AppleSimChatGPTPlugin
codex plugin add apple-device-hub@apple-device-hub
```

Fully quit and reopen ChatGPT, then start a new chat. Source, tool documentation and validation: [AppleSimChatGPTPlugin](https://github.com/mweinbach/AppleSimChatGPTPlugin). Gallery preparation is documented in the [submission packet](https://github.com/mweinbach/AppleSimChatGPTPlugin/blob/main/docs/gallery/SUBMISSION.md); the release ZIP bundles the server instead of using `npx`.
