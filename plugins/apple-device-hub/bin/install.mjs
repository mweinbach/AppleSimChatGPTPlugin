#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("apple-sim-chatgpt-plugin install [--directory PATH]\nInstalls the ChatGPT plugin, including skills, MCP server and viewer. Requires the codex CLI.\nRun apple-device-hub-mcp separately to use only the MCP server.");
} else if (args.length === 1 && args[0] === "--version") {
  console.log(version);
} else if (args[0] === "install" && (args.length === 1 || (args.length === 3 && args[1] === "--directory"))) {
  const base = args[2] ? resolve(args[2]) : join(homedir(), "Library", "Application Support", "AppleSimChatGPTPlugin");
  const destination = join(base, version);
  await mkdir(join(destination, "plugins"), { recursive: true });
  await cp(root, join(destination, "plugins", "apple-device-hub"), { recursive: true });
  await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
  await writeFile(join(destination, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "apple-sim-chatgpt-plugin",
    interface: { displayName: "Apple Device Hub" },
    plugins: [{ name: "apple-device-hub", source: { source: "local", path: "./plugins/apple-device-hub" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }]
  }, null, 2) + "\n");
  for (const command of [["plugin", "marketplace", "add", destination], ["plugin", "add", "apple-device-hub@apple-sim-chatgpt-plugin"]]) {
    const result = spawnSync("codex", command, { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      console.error(result.error?.code === "ENOENT" ? "The codex CLI must be installed and available on PATH." : "Plugin registration failed. The copied plugin is available at " + destination);
      process.exit(result.status || 1);
    }
  }
  console.log(`Installed Apple Device Hub ${version}. Restart ChatGPT and open a new task to load its tools.`);
} else {
  console.error("Unknown arguments. Use --help for usage.");
  process.exitCode = 1;
}
