# Apple Device Hub MCP

Standalone local MCP server for Apple simulators and connected devices. Includes the MCP App viewer and a prebuilt Apple Silicon macOS video helper. This package has no plugin manifest or skills, and does not install a ChatGPT plugin.

Requires an Apple Silicon Mac, macOS 14+, Node 22+, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled. Open Xcode before using a device.

Configure an MCP client to launch:

```json
{ "mcpServers": { "apple-device-hub": { "command": "npx", "args": ["--yes", "apple-device-hub-mcp@latest"] } } }
```

For ChatGPT navigation, sidebar integration and agent skills, install the plugin, which runs this package:

```sh
codex plugin marketplace add mweinbach/AppleSimChatGPTPlugin
codex plugin add apple-device-hub@apple-device-hub
```

Source, tool documentation and validation: [AppleSimChatGPTPlugin](https://github.com/mweinbach/AppleSimChatGPTPlugin).
