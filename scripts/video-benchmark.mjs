// Run with node --import tsx scripts/video-benchmark.mjs <booted-simulator-UDID>.
// Samples the real helper, including VideoToolbox hardware diagnostics.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AccessUnitReader } from "../src/video.ts";
import { inspectVideoAccessUnit } from "../src/video-codec.ts";

const deviceId = process.argv[2];
if (!deviceId) throw new Error("Pass a booted simulator UDID.");
const directory = new URL("../artifacts/validation/2026-09-30/", import.meta.url);
await mkdir(directory, { recursive: true });
const samples = [];
for (const format of ["hevc", "h264"]) {
  const sample = await new Promise((resolve, reject) => {
    const child = spawn(fileURLToPath(new URL("../plugins/apple-device-hub/dist/simulator-stream", import.meta.url)), [deviceId, "--codec", format]);
    const start = performance.now();
    const units = [];
    const reader = new AccessUnitReader();
    let firstFrameMs, lastFrameMs, codec, stderr = "", failure;
    child.stderr.on("data", data => { stderr += data; });
    child.stdout.on("data", data => {
      try {
        reader.push(data, unit => {
          firstFrameMs ??= performance.now() - start;
          lastFrameMs = performance.now() - start;
          codec ??= inspectVideoAccessUnit(unit, format).codec;
          units.push(Buffer.from(unit));
        });
      } catch (error) { failure = error; child.kill("SIGTERM"); }
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 5500);
    const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.once("error", error => { clearTimeout(timer); clearTimeout(kill); reject(error); });
    child.once("close", async code => {
      clearTimeout(timer); clearTimeout(kill);
      if (failure || code !== 0 || !units.length) { reject(failure ?? new Error(stderr)); return; }
      try {
        const diagnostics = stderr.trim().split("\n").map(line => JSON.parse(line));
        const configuration = diagnostics.find(event => event.event === "configuration");
        const bytes = units.reduce((sum, unit) => sum + unit.length, 0);
        const stats = { deviceId, format, codec, configuration, frames: units.length, bytes, firstFrameMs, frameDurationMs: lastFrameMs - firstFrameMs, fps: (units.length - 1) * 1000 / (lastFrameMs - firstFrameMs), durationMs: performance.now() - start };
        await writeFile(new URL(`native-sample.${format}`, directory), Buffer.concat(units));
        await writeFile(new URL(`native-sample-${format}.json`, directory), JSON.stringify({ ...stats, diagnostics }, null, 2));
        resolve(stats);
      } catch (error) { reject(error); }
    });
  });
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
console.log(JSON.stringify({ hevcBytesPerFrame: samples[0].bytes / samples[0].frames, h264BytesPerFrame: samples[1].bytes / samples[1].frames, hevcReductionPercent: 100 * (1 - samples[0].bytes / samples[0].frames / (samples[1].bytes / samples[1].frames)) }));
