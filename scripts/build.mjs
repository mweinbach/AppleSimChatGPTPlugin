import { mkdir, copyFile, readFile, writeFile, cp, rm } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

await import("./sync-version.mjs");
const destination = "packages/apple-device-hub-mcp/dist";
await mkdir(destination, { recursive: true });
await import("./build-native.mjs");
await build({ entryPoints: ["src/app.ts"], outfile: `${destination}/app.js`, bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
const stylesheet = await postcss([tailwindcss({ optimize: true })]).process(await readFile("src/app.css", "utf8"), { from: "src/app.css", to: `${destination}/app.css` });
await writeFile(`${destination}/app.css`, stylesheet.css);
await copyFile("node_modules/@openai/mcp-extensions/LICENSE", "packages/apple-device-hub-mcp/LICENSE.mcp-extensions");
await build({ entryPoints: ["src/server.ts"], outfile: `${destination}/server.js`, bundle: true, format: "esm", platform: "node", target: "node22", packages: "bundle", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
await rm("plugins/apple-device-hub/dist", { recursive: true, force: true });
await cp(destination, "plugins/apple-device-hub/dist", { recursive: true });
await copyFile("packages/apple-device-hub-mcp/LICENSE.mcp-extensions", "plugins/apple-device-hub/LICENSE.mcp-extensions");
