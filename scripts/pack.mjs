import { mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = fileURLToPath(new URL("../release/", import.meta.url));
await mkdir(destination, { recursive: true });
for (const directory of ["packages/apple-device-hub-mcp", "plugins/apple-device-hub"]) {
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: root + directory, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const archive = `${destination}apple-device-hub-${version}.zip`;
await rm(archive, { force: true });
const zip = spawnSync("zip", ["-q", "-r", archive, "plugin.json", "mcp.json", ".codex-plugin", ".mcp.json", "package.json", "bin", "dist", "skills", "assets", "README.md", "LICENSE.mcp-extensions"], { cwd: root + "plugins/apple-device-hub", stdio: "inherit" });
if (zip.status !== 0) process.exit(zip.status || 1);
