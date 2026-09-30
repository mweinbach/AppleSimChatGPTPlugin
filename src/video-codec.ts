export type VideoCodec = "hevc" | "h264";

export const provisionalCodec = (format: VideoCodec) => format === "hevc" ? "hev1.1.6.L150.B0" : "avc1.42E01F";

/** RFC 6381 HEVC codec identity comes from the SPS profile_tier_level. */
function hevcCodec(sps: Uint8Array): string | undefined {
  const rbsp: number[] = [];
  let zeros = 0;
  for (const byte of sps.subarray(2)) {
    if (zeros === 2 && byte === 3) { zeros = 0; continue; }
    rbsp.push(byte);
    zeros = byte === 0 ? Math.min(2, zeros + 1) : 0;
  }
  if (rbsp.length < 13) return undefined;
  const profile = rbsp[1]!;
  const space = ["", "A", "B", "C"][profile >>> 6];
  let compatibility = 0;
  for (let index = 0; index < 32; index++) {
    if (rbsp[2 + (index >>> 3)]! & (1 << (7 - (index & 7)))) compatibility = (compatibility | (1 << index)) >>> 0;
  }
  const constraints = rbsp.slice(6, 12);
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const suffix = constraints.map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(".");
  return `hev1.${space}${profile & 31}.${compatibility.toString(16).toUpperCase()}.${profile & 32 ? "H" : "L"}${rbsp[12]}${suffix ? `.${suffix}` : ""}`;
}

/** Access units contain in-band parameter sets on independently decodable frames. */
export function inspectVideoAccessUnit(data: Uint8Array, format: VideoCodec = "h264") {
  let keyFrame = false, hasPicture = false, hasSps = false, hasPps = false, hasVps = false;
  let codec: string | undefined;
  const starts: Array<{ prefix: number; payload: number }> = [];
  for (let index = 0; index < data.length - 3; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    const length = data[index + 2] === 1 ? 3 : data[index + 2] === 0 && data[index + 3] === 1 ? 4 : 0;
    if (!length || index + length >= data.length) continue;
    starts.push({ prefix: index, payload: index + length });
    index += length - 1;
  }
  for (let index = 0; index < starts.length; index++) {
    const nal = data.subarray(starts[index]!.payload, starts[index + 1]?.prefix ?? data.length);
    if (format === "hevc") {
      if (nal.length < 2) continue;
      const type = (nal[0]! >>> 1) & 63;
      hasPicture ||= type <= 31;
      keyFrame ||= type >= 16 && type <= 21;
      hasVps ||= type === 32;
      hasSps ||= type === 33;
      hasPps ||= type === 34;
      if (type === 33) codec = hevcCodec(nal);
    } else {
      const type = nal[0]! & 31;
      hasPicture ||= type === 1 || type === 5;
      keyFrame ||= type === 5;
      hasPps ||= type === 8;
      if (type === 7 && nal.length >= 4) {
        hasSps = true;
        codec = `avc1.${Array.from(nal.subarray(1, 4), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
      }
    }
  }
  return { keyFrame, hasPicture, hasParameterSets: hasSps && hasPps && (format === "h264" || hasVps), codec };
}

export async function preferredVideoCodec(): Promise<VideoCodec> {
  if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") return "h264";
  try {
    const support = await VideoDecoder.isConfigSupported({ codec: provisionalCodec("hevc"), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    return support.supported ? "hevc" : "h264";
  } catch { return "h264"; }
}
