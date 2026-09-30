import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppleHub } from "./apple.js";
import { createHubServer } from "./mcp.js";

const hub = new AppleHub();
const assetRoot = import.meta.url.endsWith("/src/server.ts") ? new URL("../plugins/apple-device-hub/dist/", import.meta.url) : new URL("./", import.meta.url);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await hub.close(); }
  catch (error) { console.error("Device session cleanup failed:", error); }
  finally { process.exit(0); }
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
if (process.argv.includes("--preview")) {
  const { startPreview } = await import("./preview.js");
  await startPreview(hub, assetRoot);
} else {
  const server = createHubServer(hub, assetRoot);
  server.server.onclose = () => { void hub.close().catch(error => console.error("Device session cleanup failed:", error)); };
  await server.connect(new StdioServerTransport());
}
