import { createServer } from "node:http";
import { appHtml, callHubTool, type Hub } from "./mcp.js";

export async function startPreview(hub: Hub, assetRoot: URL) {
  const port = Number(process.env.APPLE_DEVICE_HUB_PREVIEW_PORT ?? 4319);
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(403).end("Open the preview at its 127.0.0.1 address."); return; }
    if (request.method === "GET" && request.url?.split("?")[0] === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await appHtml(assetRoot, true)); return; }
    if (request.method === "POST" && request.url === "/api/tool") {
      if ((request.headers.origin && request.headers.origin !== origin) || !request.headers["content-type"]?.startsWith("application/json")) { response.writeHead(403).end("Only the local viewer can call device tools."); return; }
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 65536) throw new Error("Tool request is too large."); }
        const input = JSON.parse(body) as { name?: unknown; arguments?: unknown };
        if (typeof input.name !== "string") throw new Error("Tool name is required.");
        const result = await callHubTool(hub, input.name, input.arguments ?? {});
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] })); }
      return;
    }
    response.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.error(`Apple Device Hub preview: ${origin}`);
  return server;
}
