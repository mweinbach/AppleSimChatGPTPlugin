import { readFile, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const file of ["packages/apple-device-hub-mcp/package.json", "plugins/apple-device-hub/package.json", "plugins/apple-device-hub/.codex-plugin/plugin.json"]) {
  const url = new URL(`../${file}`, import.meta.url);
  const metadata = JSON.parse(await readFile(url, "utf8"));
  metadata.version = version;
  await writeFile(url, JSON.stringify(metadata, null, 2) + "\n");
}
