# Apple Device Hub MCP

Standalone local MCP server for Apple simulators and connected devices. Includes the MCP App viewer and a prebuilt universal macOS video helper. This package has no plugin manifest or skills, and does not install a ChatGPT plugin.

Requires macOS 14+, Node 22+, and Xcode 27 with **Settings → Intelligence → Model Context Protocol** enabled. Open Xcode before using a device.

Configure an MCP client to launch:

```json
{ "mcpServers": { "apple-device-hub": { "command": "npx", "args": ["--yes", "apple-device-hub-mcp@latest"] } } }
```

For ChatGPT navigation, sidebar integration and skills, install the separate plugin:

```sh
npx --yes apple-sim-chatgpt-plugin@latest install
```

Source, tool documentation and validation: [AppleSimChatGPTPlugin](https://github.com/mweinbach/AppleSimChatGPTPlugin).
