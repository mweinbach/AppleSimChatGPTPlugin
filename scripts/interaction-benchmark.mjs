// Run with node --import tsx scripts/interaction-benchmark.mjs <booted-simulator-UDID> [hevc|h264] [--max-dimension <pixels>].
// Drives a real HID drag on the Home screen through the helper's input channel and
// measures the encoded frame rate, bandwidth, and input-to-frame latency.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AccessUnitReader } from "../src/video.ts";
import { inspectVideoAccessUnit } from "../src/video-codec.ts";

const [deviceId, format = "hevc", ...extra] = process.argv.slice(2);
if (!deviceId) throw new Error("Pass a booted simulator UDID.");
const helper = fileURLToPath(new URL("../plugins/apple-device-hub/dist/simulator-stream", import.meta.url));
const child = spawn(helper, [deviceId, "--codec", format, ...extra], { stdio: ["pipe", "pipe", "pipe"] });
const frames = [];
const reader = new AccessUnitReader();
let stderr = "";
child.stderr.on("data", data => { stderr += data; });
child.stdout.on("data", data => reader.push(data, unit => {
  const info = inspectVideoAccessUnit(unit, format);
  frames.push({ at: performance.now(), bytes: unit.length, key: info.keyFrame });
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = line => child.stdin.write(`${line}\n`);
const until = async (condition, timeout) => { const end = performance.now() + timeout; while (!condition() && performance.now() < end) await sleep(5); };

await until(() => frames.length > 0, 5000);
if (!frames.length) throw new Error(`No frames: ${stderr}`);
await sleep(1200);

const latencies = [];
for (let trial = 0; trial < 3; trial++) {
  const before = frames.length;
  const start = performance.now();
  send("t d 0.5 0.5");
  send("t m 0.42 0.5");
  await until(() => frames.length > before && frames.at(-1).at > start, 1000);
  latencies.push(frames.length > before ? frames.find((frame, index) => index >= before && frame.at > start).at - start : NaN);
  send("t u 0.42 0.5");
  await sleep(900);
}

const dragStart = performance.now();
const dragFrames = frames.length;
for (let step = 0; step < 300; step++) {
  const x = 0.5 + 0.25 * Math.sin(step / 300 * 6 * Math.PI);
  send(`t ${step ? "m" : "d"} ${x.toFixed(4)} 0.5`);
  await sleep(1000 / 120);
}
send("t u 0.5 0.5");
const dragEnd = performance.now();
const window = frames.slice(dragFrames).filter(frame => frame.at <= dragEnd);
const intervals = window.slice(1).map((frame, index) => frame.at - window[index].at).sort((a, b) => a - b);
await sleep(800);
child.kill("SIGTERM");
await new Promise(resolve => child.once("close", resolve));
const diagnostics = stderr.trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const seconds = (dragEnd - dragStart) / 1000;
const bytes = window.reduce((sum, frame) => sum + frame.bytes, 0);
console.log(JSON.stringify({
  format, extra,
  configuration: diagnostics.find(event => event.event === "configuration"),
  input: diagnostics.find(event => event.event === "input"),
  drag: {
    seconds: Number(seconds.toFixed(2)),
    frames: window.length,
    fps: Number((window.length / seconds).toFixed(1)),
    intervalP50Ms: Number(intervals[Math.floor(intervals.length / 2)]?.toFixed(1)),
    intervalP95Ms: Number(intervals[Math.floor(intervals.length * 0.95)]?.toFixed(1)),
    keyFrames: window.filter(frame => frame.key).length,
    megabitsPerSecond: Number((bytes * 8 / seconds / 1e6).toFixed(2)),
    averageFrameKB: Number((bytes / window.length / 1024).toFixed(1)),
  },
  inputToFrameMs: latencies.map(value => Number(value.toFixed(1))),
  stopped: diagnostics.find(event => event.event === "stopped"),
  errors: diagnostics.filter(event => /error/.test(event.event)),
}, null, 2));
