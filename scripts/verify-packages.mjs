import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "apple-packages-"));
try {
  for (const name of ["apple-device-hub-mcp", "apple-sim-chatgpt-plugin"]) {
    const extracted = join(directory, name);
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", join(root, "release", `${name}-${version}.tgz`), "-C", extracted]);
    const packageRoot = join(extracted, "package");
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    assert.ok(!metadata.dependencies, "Runtime dependencies must be bundled");
    const bin = join(packageRoot, Object.values(metadata.bin)[0]);
    assert.equal(execFileSync(process.execPath, [bin, "--version"], { cwd: directory, encoding: "utf8" }).trim(), version);
    assert.match(execFileSync(process.execPath, [bin, "--help"], { cwd: directory, encoding: "utf8" }), new RegExp(name));
    const native = join(packageRoot, "dist", "simulator-stream");
    assert.deepEqual(execFileSync("xcrun", ["lipo", "-archs", native], { encoding: "utf8" }).trim().split(/\s+/), ["arm64"]);
    execFileSync("codesign", ["--verify", "--strict", native]);
    const client = new Client({ name: "package-verification", version: "1" });
    const server = name === "apple-device-hub-mcp" ? bin : join(packageRoot, "dist", "server.js");
    const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: directory, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    try {
      await client.connect(transport, { timeout: 15_000 });
      assert.equal(client.getServerVersion().version, version);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 20);
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
    if (name === "apple-device-hub-mcp") {
      await assert.rejects(readFile(join(packageRoot, ".codex-plugin", "plugin.json")), /ENOENT/);
      await assert.rejects(readFile(join(packageRoot, "skills", "device-hub", "SKILL.md")), /ENOENT/);
    } else {
      const manifest = JSON.parse(await readFile(join(packageRoot, ".codex-plugin", "plugin.json"), "utf8"));
      assert.equal(manifest.version, version);
      const portable = JSON.parse(await readFile(join(packageRoot, "plugin.json"), "utf8"));
      assert.equal(portable.version, version);
      assert.deepEqual(portable.extensions["com.openai"].interface, manifest.interface);
      assert.deepEqual(JSON.parse(await readFile(join(packageRoot, "mcp.json"), "utf8")).mcpServers["apple-device-hub"].args, ["./dist/server.js"]);
      assert.ok((await readFile(join(packageRoot, "skills", "device-hub", "SKILL.md"), "utf8")).length > 0);
      const configuration = JSON.parse(await readFile(join(packageRoot, ".mcp.json"), "utf8"));
      assert.deepEqual(configuration.mcpServers["apple-device-hub"].args, ["./dist/server.js"]);
      const mockBin = join(directory, "bin");
      await mkdir(mockBin);
      const calls = join(directory, "codex-calls.jsonl");
      await writeFile(join(mockBin, "codex"), `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.PLUGIN_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(Number(process.env.PLUGIN_TEST_EXIT || 0));\n`);
      await chmod(join(mockBin, "codex"), 0o755);
      const env = { ...process.env, PATH: `${mockBin}:${process.env.PATH}`, PLUGIN_TEST_CALLS: calls };
      const base = join(directory, "persistent plugin");
      const args = [bin, "install", "--directory", base];
      execFileSync(process.execPath, args, { cwd: directory, env });
      const installed = join(base, version);
      assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [
        ["plugin", "marketplace", "add", installed], ["plugin", "add", "apple-device-hub@apple-sim-chatgpt-plugin"]
      ]);
      assert.deepEqual(await readFile(join(installed, "plugins", "apple-device-hub", "dist", "server.js")), await readFile(join(packageRoot, "dist", "server.js")));
      assert.deepEqual(await readFile(join(installed, "plugins", "apple-device-hub", "plugin.json")), await readFile(join(packageRoot, "plugin.json")));
      const marketplace = JSON.parse(await readFile(join(installed, ".agents", "plugins", "marketplace.json"), "utf8"));
      assert.equal(marketplace.name, "apple-sim-chatgpt-plugin");
      execFileSync(process.execPath, args, { cwd: directory, env });
      assert.throws(() => execFileSync(process.execPath, args, { cwd: directory, env: { ...env, PLUGIN_TEST_EXIT: "7" }, stdio: "pipe" }), error => error.status === 7);
    }
    console.log(`Verified ${name}@${version}: isolated MCP, viewer, signed arm64 helper${name.includes("plugin") ? ", plugin installer and skills" : ""}.`);
  }
  for (const file of ["server.js", "app.js", "app.css", "simulator-stream"]) {
    assert.deepEqual(await readFile(join(directory, "apple-device-hub-mcp", "package", "dist", file)), await readFile(join(directory, "apple-sim-chatgpt-plugin", "package", "dist", file)), `Plugin bundles the exact MCP build: ${file}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
await import("./verify-gallery.mjs");
