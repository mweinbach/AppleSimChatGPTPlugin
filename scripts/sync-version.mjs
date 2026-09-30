import { readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const file of ["packages/apple-device-hub-mcp/package.json", "plugins/apple-device-hub/package.json", "plugins/apple-device-hub/plugin.json"]) {
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
