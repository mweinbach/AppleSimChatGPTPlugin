import { readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const file of ["packages/apple-device-hub-mcp/package.json", "plugins/apple-device-hub/plugin.json"]) {
  const url = new URL(`../${file}`, import.meta.url);
  const metadata = JSON.parse(await readFile(url, "utf8"));
  metadata.version = version;
  await writeFile(url, JSON.stringify(metadata, null, 2) + "\n");
}
const manifest = JSON.parse(await readFile(new URL("../plugins/apple-device-hub/plugin.json", import.meta.url), "utf8"));
const { $schema, extensions, ...identity } = manifest;
const { interface: presentation, ...openai } = extensions["com.openai"];
await writeFile(new URL("../plugins/apple-device-hub/.codex-plugin/plugin.json", import.meta.url), JSON.stringify({
  ...identity, skills: "./skills/", interface: presentation, mcpServers: "./.mcp.json", extensions: { "com.openai": openai },
}, null, 2) + "\n");
// A Git-installed plugin has no build output; it runs the published server of the same version.
const server = { command: "npx", args: ["--yes", `apple-device-hub-mcp@${version}`] };
await writeFile(new URL("../plugins/apple-device-hub/.mcp.json", import.meta.url), JSON.stringify({ mcpServers: { "apple-device-hub": server } }, null, 2) + "\n");
await writeFile(new URL("../plugins/apple-device-hub/mcp.json", import.meta.url), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { "apple-device-hub": { type: "stdio", ...server } },
}, null, 2) + "\n");
