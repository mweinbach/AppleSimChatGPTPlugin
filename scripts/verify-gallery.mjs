import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archive = join(root, "release", `apple-device-hub-${version}.zip`);
assert.ok((await stat(archive)).size <= 100_000_000, "ZIP exceeds the portal size limit");
const directory = await mkdtemp(join(tmpdir(), "apple-gallery-"));
try {
  execFileSync("unzip", ["-q", archive, "-d", directory]);
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "apple-device-hub");
  assert.equal(manifest.version, version);
  const extension = manifest.extensions["com.openai"];
  const listing = extension.interface;
  assert.ok(listing.displayName.length <= 30 && listing.shortDescription.length <= 30);
  assert.ok(listing.longDescription.length <= 4000);
  assert.equal(extension.review.test_cases.positive.length, 5);
  assert.equal(extension.review.test_cases.negative.length, 3);
  assert.ok(extension.publication.release_notes.length > 0);
  assert.equal(listing.defaultPrompt.length, 3);
  for (const prompt of listing.defaultPrompt) assert.ok(prompt.length <= 128 && !prompt.includes("@"));
  for (const asset of [listing.logo, listing.composerIcon]) assert.ok((await stat(join(directory, asset))).size > 0);
  const overlay = JSON.parse(await readFile(join(directory, ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(overlay.interface, listing);
  assert.deepEqual(overlay.extensions["com.openai"].review, extension.review);
  assert.match(await readFile(join(directory, "skills", "device-hub", "SKILL.md"), "utf8"), /^---\nname: device-hub\n/);
  const mcp = JSON.parse(await readFile(join(directory, "mcp.json"), "utf8"));
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.equal(Object.keys(mcp.mcpServers).length, 1);
  const configuration = mcp.mcpServers["apple-device-hub"];
  assert.equal(configuration.type, "stdio");
  assert.equal(configuration.command, "node");
  assert.equal(configuration.cwd, "./");
  assert.deepEqual(configuration.args, ["./dist/server.js"]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8")).mcpServers["apple-device-hub"].args, ["./dist/server.js"], "The ZIP's Codex overlay also runs its bundled server");
  const transport = new StdioClientTransport({ command: process.execPath, args: configuration.args.map(arg => resolve(directory, arg)), cwd: resolve(directory, configuration.cwd), stderr: "pipe" });
  const client = new Client({ name: "gallery-package-verification", version: "1" });
  try {
    await client.connect(transport, { timeout: 15_000 });
    assert.equal(client.getServerVersion().version, version);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 22);
    for (const testCase of extension.review.test_cases.positive) {
      for (const name of testCase.tools_triggered.split(", ")) assert.ok(tools.some(tool => tool.name === name), `Review case references missing tool ${name}`);
    }
    const entrypoints = tools.flatMap(tool => tool._meta?.["openai/ui"]?.entrypoints ?? []).map(entry => entry.type);
    assert.deepEqual([...new Set(entrypoints)].sort(), ["global", "settings", "thread"]);
    assert.ok((await client.readResource({ uri: "ui://apple-device-hub/viewer" })).contents[0].text.length > 100_000);
  } finally {
    await client.close();
  }
  for (const file of ["server.js", "app.js", "app.css", "simulator-stream"]) {
    assert.deepEqual(await readFile(join(directory, "dist", file)), await readFile(join(root, "packages", "apple-device-hub-mcp", "dist", file)));
  }
  execFileSync("codesign", ["--verify", "--strict", join(directory, "dist", "simulator-stream")]);
  console.log(`Verified apple-device-hub-${version}.zip: portable manifest, review metadata, isolated 22-tool MCP, viewer and signed native helper. Local MCP partner approval remains required.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
