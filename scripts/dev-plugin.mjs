// Builds this checkout and installs it as the Apple Device Hub plugin in place
// of the published one. Restore the published plugin with:
//   codex plugin remove apple-device-hub@apple-device-hub-dev
//   codex plugin add apple-device-hub@apple-device-hub
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await import("./build.mjs");

const marketplace = `${root}.dev-plugin/`;
const plugin = `${marketplace}plugins/apple-device-hub/`;
await rm(marketplace, { recursive: true, force: true });
await mkdir(`${marketplace}.agents/plugins`, { recursive: true });
await cp("plugins/apple-device-hub", plugin, { recursive: true });
await writeFile(`${marketplace}.agents/plugins/marketplace.json`, JSON.stringify({
  name: "apple-device-hub-dev",
  interface: { displayName: "Apple Device Hub (development)" },
  plugins: [{ name: "apple-device-hub", source: { source: "local", path: "./plugins/apple-device-hub" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
}, null, 2) + "\n");
await writeFile(`${plugin}.mcp.json`, JSON.stringify({ mcpServers: { "apple-device-hub": { command: "node", args: ["./dist/server.js"], cwd: "." } } }, null, 2) + "\n");
await writeFile(`${plugin}mcp.json`, JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { "apple-device-hub": { type: "stdio", command: "node", args: ["./dist/server.js"], cwd: "./" } } }, null, 2) + "\n");
// The host caches installed plugins by version, so each build needs a distinct one.
const manifestPath = `${plugin}.codex-plugin/plugin.json`;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = `${manifest.version}+codex.${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const codex = (...args) => spawnSync("codex", args, { stdio: "pipe", encoding: "utf8" });
// Two installed copies would register the same MCP server name.
codex("plugin", "remove", "apple-device-hub@apple-device-hub");
for (const args of [["plugin", "marketplace", "add", marketplace], ["plugin", "add", "apple-device-hub@apple-device-hub-dev"]]) {
  const result = codex(...args);
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ENOENT" ? "The codex CLI must be on PATH." : result.stderr || result.stdout;
    throw new Error(`codex ${args.join(" ")} failed. ${reason}`.trim());
  }
}
console.log(`Installed Apple Device Hub ${manifest.version} from this checkout. Start a new chat to load it.`);
