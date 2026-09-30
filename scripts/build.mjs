import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const destination = "plugins/apple-device-hub/dist";
await mkdir(destination, { recursive: true });
await import("./build-native.mjs");
await build({ entryPoints: ["src/app.ts"], outfile: `${destination}/app.js`, bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
const stylesheet = await postcss([tailwindcss({ optimize: true })]).process(await readFile("src/app.css", "utf8"), { from: "src/app.css", to: `${destination}/app.css` });
await writeFile(`${destination}/app.css`, stylesheet.css);
await copyFile("node_modules/@openai/mcp-extensions/LICENSE", "plugins/apple-device-hub/LICENSE.mcp-extensions");
await build({ entryPoints: ["src/server.ts"], outfile: `${destination}/server.js`, bundle: true, format: "esm", platform: "node", target: "node22", packages: "bundle", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
await writeFile("plugins/apple-device-hub/package.json", JSON.stringify({ name: "apple-device-hub", version: "0.1.0", type: "module", private: true }, null, 2) + "\n");
