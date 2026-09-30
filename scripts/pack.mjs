import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = fileURLToPath(new URL("../release/", import.meta.url));
await mkdir(destination, { recursive: true });
for (const directory of ["packages/apple-device-hub-mcp", "plugins/apple-device-hub"]) {
  const result = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: root + directory, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
