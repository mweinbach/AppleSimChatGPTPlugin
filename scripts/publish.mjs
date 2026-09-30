import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(root + "package.json", "utf8"));
for (const name of ["apple-device-hub-mcp", "apple-sim-chatgpt-plugin"]) {
  const archive = `${root}release/${name}-${version}.tgz`;
  const integrity = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], { encoding: "utf8" });
  if (integrity.status === 0 && integrity.stdout.trim()) {
    // A failed second publish can be retried without attempting to overwrite the first.
    const existing = spawnSync("npm", ["pack", archive, "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
    if (existing.status !== 0) throw new Error(existing.stderr);
    if (JSON.parse(existing.stdout)[0].integrity !== JSON.parse(integrity.stdout)) throw new Error(`${name}@${version} already exists with different bytes. Bump the version.`);
    console.log(`${name}@${version} is already published with matching integrity.`);
    continue;
  }
  if (integrity.status !== 0 && !integrity.stderr.includes("E404")) throw new Error(integrity.stderr);
  const result = spawnSync("npm", ["publish", archive, "--provenance", "--access", "public", "--tag", version.includes("-") ? "next" : "latest"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
