// Manual browser acceptance fixture: HEVC capture fails, H.264 uses the real helper.
// Run with node --import tsx scripts/video-fallback-preview.mjs, then connect locally.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppleHub } from "../src/apple.ts";
import { SimulatorVideo } from "../src/video.ts";
import { startPreview } from "../src/preview.ts";

const helper = fileURLToPath(new URL("../plugins/apple-device-hub/dist/simulator-stream", import.meta.url));
const hub = new AppleHub({ video: new SimulatorVideo({ launch(deviceId, codec) {
  console.error(`Validation capture requested: ${codec}`);
  if (codec === "hevc") return spawn(process.execPath, ["-e", 'console.error(JSON.stringify({ event: "error", message: "Hardware HEVC unavailable (validation fixture)." })); process.exit(1);']);
  return spawn(helper, [deviceId, "--codec", "h264"]);
} }) });
const server = await startPreview(hub, new URL("../plugins/apple-device-hub/dist/", import.meta.url));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await hub.close();
  server.close(() => process.exit(0));
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
