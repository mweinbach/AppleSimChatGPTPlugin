import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = fileURLToPath(new URL("../release/", import.meta.url));
await mkdir(destination, { recursive: true });
const pack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: root + "packages/apple-device-hub-mcp", stdio: "inherit" });
if (pack.status !== 0) process.exit(pack.status || 1);

// The ZIP is self-contained: it runs its bundled server instead of fetching the npm package.
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const archive = `${destination}apple-device-hub-${version}.zip`;
const stage = await mkdtemp(join(tmpdir(), "apple-device-hub-zip-"));
try {
  const files = ["plugin.json", "mcp.json", ".codex-plugin", "dist", "skills", "assets", "README.md", "LICENSE.mcp-extensions"];
  for (const file of files) await cp(join(root, "plugins/apple-device-hub", file), join(stage, file), { recursive: true });
  await writeFile(join(stage, ".mcp.json"), JSON.stringify({ mcpServers: { "apple-device-hub": { command: "node", args: ["./dist/server.js"], cwd: "." } } }, null, 2) + "\n");
  await rm(archive, { force: true });
  const zip = spawnSync("zip", ["-q", "-r", archive, ...files, ".mcp.json"], { cwd: stage, stdio: "inherit" });
  if (zip.status !== 0) process.exit(zip.status || 1);
} finally {
  await rm(stage, { recursive: true, force: true });
}
