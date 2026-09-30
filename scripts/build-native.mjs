import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = "packages/apple-device-hub-mcp/dist";
await mkdir(new URL(`../${destination}/`, import.meta.url), { recursive: true });

const compilation = spawnSync("xcrun", ["clang", "-arch", "arm64", "-arch", "x86_64", "-fobjc-arc", "-fblocks", "-O2", "-Wall", "-Wextra", "-Wno-unused-parameter", "-mmacosx-version-min=14.0", "native/SimulatorStream.m", "-o", `${destination}/simulator-stream`, "-framework", "Foundation", "-framework", "CoreImage", "-framework", "CoreVideo", "-framework", "CoreMedia", "-framework", "CoreGraphics", "-framework", "VideoToolbox", "-framework", "IOSurface", "-framework", "ImageIO"], { cwd: root, stdio: "inherit" });
if (compilation.status !== 0) throw new Error("Native simulator stream compilation failed.");

const signing = spawnSync("codesign", ["--force", "--sign", "-", `${destination}/simulator-stream`], { cwd: root, stdio: "inherit" });
if (signing.status !== 0) throw new Error("Native simulator stream signing failed.");
