import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const name = "apple-device-hub-mcp";
const directory = await mkdtemp(join(tmpdir(), "apple-packages-"));
try {
  execFileSync("tar", ["-xzf", join(root, "release", `${name}-${version}.tgz`), "-C", directory]);
  const packageRoot = join(directory, "package");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  assert.ok(!metadata.dependencies, "Runtime dependencies must be bundled");
  const bin = join(packageRoot, metadata.bin[name]);
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { cwd: directory, encoding: "utf8" }).trim(), version);
  assert.match(execFileSync(process.execPath, [bin, "--help"], { cwd: directory, encoding: "utf8" }), new RegExp(name));
  const native = join(packageRoot, "dist", "simulator-stream");
  assert.deepEqual(execFileSync("xcrun", ["lipo", "-archs", native], { encoding: "utf8" }).trim().split(/\s+/), ["arm64"]);
  execFileSync("codesign", ["--verify", "--strict", native]);
  await assert.rejects(readFile(join(packageRoot, ".codex-plugin", "plugin.json")), /ENOENT/);
  const client = new Client({ name: "package-verification", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin], cwd: directory, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  try {
    await client.connect(transport, { timeout: 15_000 });
    assert.equal(client.getServerVersion().version, version);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 22);
    const entrypoints = tools.flatMap(tool => tool._meta?.["openai/ui"]?.entrypoints ?? []).map(entry => entry.type);
    assert.deepEqual([...new Set(entrypoints)].sort(), ["global", "settings", "thread"]);
    const resource = await client.readResource({ uri: "ui://apple-device-hub/viewer" });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(resource.contents[0].text.length > 100_000, "Viewer assets must be bundled in HTML");
  } catch (error) {
    throw new Error(`${name} packaged MCP failed: ${stderr}`, { cause: error });
  } finally {
    await client.close();
  }
  console.log(`Verified ${name}@${version}: isolated MCP, viewer, signed arm64 helper.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

// The Git-installed plugin contains only manifests, skills and assets, and runs the npm server of its own version.
const plugin = join(root, "plugins", "apple-device-hub");
const marketplace = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
assert.equal(marketplace.name, "apple-device-hub");
assert.deepEqual(marketplace.plugins.map(entry => [entry.name, entry.source.path]), [["apple-device-hub", "./plugins/apple-device-hub"]]);
const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
assert.equal(manifest.version, version);
assert.equal(JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8")).version, version);
assert.deepEqual(JSON.parse(await readFile(join(plugin, manifest.mcpServers), "utf8")).mcpServers["apple-device-hub"], { command: "npx", args: ["--yes", `${name}@${version}`] });
assert.deepEqual(JSON.parse(await readFile(join(plugin, "mcp.json"), "utf8")).mcpServers["apple-device-hub"], { type: "stdio", command: "npx", args: ["--yes", `${name}@${version}`] });
const tracked = execFileSync("git", ["ls-files", "plugins/apple-device-hub"], { cwd: root, encoding: "utf8" }).trim().split("\n");
assert.ok(!tracked.some(file => file.includes("/dist/")), "The plugin's server comes from npm, not committed build output");
const skills = await readdir(join(plugin, "skills"));
for (const skill of skills) assert.match(await readFile(join(plugin, "skills", skill, "SKILL.md"), "utf8"), new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
console.log(`Verified the Git plugin: marketplace apple-device-hub, ${name}@${version} over npx, skills ${skills.join(", ")}.`);

await import("./verify-gallery.mjs");
