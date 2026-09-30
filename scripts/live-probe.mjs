// Interactive acceptance probe against the packaged MCP server. JSON requests
// on stdin call actual tools; screenshots are saved locally for inspection.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const client = new Client({ name: "device-hub-live-validation", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../plugins/apple-device-hub/dist/server.js", import.meta.url))], stderr: "pipe" });
transport.stderr?.on("data", data => process.stderr.write(data));
const directory = new URL("../artifacts/validation/2026-09-30/", import.meta.url);
await mkdir(directory, { recursive: true });
await client.connect(transport);
const sessions = new Set();
let sequence = 0;
const input = createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true, tools: (await client.listTools()).tools.map(tool => tool.name) }));
try {
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      if (request.name === "close") break;
      if (request.name === "video_sample") {
        const result = await client.callTool({ name: "device_stream", arguments: { sessionId: request.sessionId, codec: request.codec ?? "h264" } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        const start = performance.now();
        const stats = await new Promise((resolve, reject) => {
          const socket = new WebSocket(result.structuredContent.url);
          let frames = 0, bytes = 0, firstFrame;
          const timer = setTimeout(() => { socket.close(); resolve({ frames, bytes, firstFrameMs: firstFrame, durationMs: performance.now() - start }); }, 5000);
          socket.on("error", error => { clearTimeout(timer); reject(error); });
          socket.on("message", (data, binary) => {
            if (!binary) { clearTimeout(timer); socket.close(); reject(new Error(data.toString())); return; }
            frames++; bytes += data.length;
            firstFrame ??= performance.now() - start;
          });
        });
        console.log(JSON.stringify({ name: request.name, ...stats }));
        continue;
      }
      if (request.name === "relay_sample") {
        const result = await client.callTool({ name: "device_stream", arguments: { sessionId: request.sessionId, codec: request.codec ?? "h264" } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        const stream = result.structuredContent;
        const start = performance.now();
        const units = [];
        let batches = 0, firstFrame;
        try {
          while (performance.now() - start < 5000) {
            const batchResult = await client.callTool({ name: "device_stream_read", arguments: { sessionId: request.sessionId, streamId: stream.streamId } });
            if (batchResult.isError) throw new Error(JSON.stringify(batchResult.content));
            const batch = batchResult._meta["apple-device-hub/video"];
            batches++;
            for (const frame of batch.frames) {
              firstFrame ??= performance.now() - start;
              units.push(Buffer.from(frame, "base64"));
            }
          }
          const stats = { name: request.name, codec: stream.format, sessionId: request.sessionId, frames: units.length, bytes: units.reduce((total, unit) => total + unit.length, 0), batches, firstFrameMs: firstFrame, durationMs: performance.now() - start };
          await writeFile(new URL(`relay-sample.${stream.format}`, directory), Buffer.concat(units));
          await writeFile(new URL(`relay-sample-${stream.format}.json`, directory), JSON.stringify(stats, null, 2));
          console.log(JSON.stringify(stats));
        } finally {
          await client.callTool({ name: "device_stream_stop", arguments: { sessionId: request.sessionId, streamId: stream.streamId } });
        }
        continue;
      }
      const result = await client.callTool({ name: request.name, arguments: request.arguments ?? {} });
      if (request.name === "device_connect" && !result.isError) sessions.add(result.structuredContent.id);
      if (request.name === "device_disconnect" && !result.isError) sessions.delete(request.arguments.sessionId);
      const image = result.content.find(item => item.type === "image");
      let screenshot;
      if (image) {
        screenshot = fileURLToPath(new URL(`${++sequence}-${request.name}.${image.mimeType === "image/png" ? "png" : "jpg"}`, directory));
        await writeFile(screenshot, Buffer.from(image.data, "base64"));
      }
      const observation = { name: request.name, isError: result.isError ?? false, state: result.structuredContent, text: result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), ...(screenshot ? { screenshot } : {}) };
      await writeFile(new URL(`${sequence}-${request.name}.json`, directory), JSON.stringify(observation, null, 2));
      console.log(JSON.stringify(observation));
    } catch (error) { console.log(JSON.stringify({ error: String(error) })); }
  }
} finally {
  input.close();
  process.stdin.pause();
  for (const sessionId of sessions) await client.callTool({ name: "device_disconnect", arguments: { sessionId } }).catch(() => {});
  await client.close();
}
