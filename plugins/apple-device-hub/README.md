# Apple Device Hub ChatGPT Plugin

Plugin for ChatGPT desktop containing device skills, plugin metadata, and a bundled build of the independent `apple-device-hub-mcp` server and its viewer. The plugin starts its included server directly; it does not fetch npm packages at runtime.

Requires macOS 14+, Node 22+, the ChatGPT desktop host with local plugin support, its `codex` CLI on PATH, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled.

```sh
npx --yes apple-sim-chatgpt-plugin@latest install
```

The installer copies the plugin to a persistent version directory in `~/Library/Application Support/AppleSimChatGPTPlugin`, registers its local marketplace, and installs `apple-device-hub`. Fully quit and reopen ChatGPT, then start a new task. Run the same command to install a newer release. Use `install --directory PATH` to choose another persistent installation directory.

To use only the MCP server in another client, launch `npx --yes apple-device-hub-mcp@latest` instead.

Source, tool documentation and validation: [AppleSimChatGPTPlugin](https://github.com/mweinbach/AppleSimChatGPTPlugin).
