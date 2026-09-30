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

class BitReader {
  position = 0;
  constructor(private readonly bytes: number[]) {}
  bit() {
    if (this.position >= this.bytes.length * 8) throw new RangeError("SPS ended early.");
    const value = (this.bytes[this.position >> 3]! >> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }
  bits(count: number) { let value = 0; for (let index = 0; index < count; index++) value = value * 2 + this.bit(); return value; }
  ue() { let zeros = 0; while (!this.bit()) if (++zeros > 31) throw new RangeError("Invalid SPS code."); return 2 ** zeros - 1 + this.bits(zeros); }
  se() { const value = this.ue(); return value % 2 ? (value + 1) / 2 : -value / 2; }
}

class BitWriter {
  readonly bytes: number[] = [];
  private length = 0;
  bit(value: number) {
    if (!(this.length & 7)) this.bytes.push(0);
    if (value) this.bytes[this.bytes.length - 1]! |= 1 << (7 - (this.length & 7));
    this.length++;
  }
  ue(value: number) {
    const code = value + 1;
    const width = Math.floor(Math.log2(code));
    for (let index = 0; index < width; index++) this.bit(0);
    for (let index = width; index >= 0; index--) this.bit(Math.floor(code / 2 ** index) % 2);
  }
  trailing() { this.bit(1); while (this.length & 7) this.bit(0); }
}

function unescapeRbsp(payload: Uint8Array) {
  const rbsp: number[] = [];
  let zeros = 0;
  for (const byte of payload) {
    if (zeros === 2 && byte === 3) { zeros = 0; continue; }
    rbsp.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return rbsp;
}

function escapeRbsp(rbsp: number[]) {
  const payload: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros === 2 && byte <= 3) { payload.push(3); zeros = 0; }
    payload.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return payload;
}

/** Rewrites an SPS without VUI to declare no frame reordering; undefined when it cannot be done safely. */
function spsWithoutReordering(nal: Uint8Array): Uint8Array | undefined {
  const rbsp = unescapeRbsp(nal.subarray(1));
  const reader = new BitReader(rbsp);
  try {
    const profile = reader.bits(8);
    reader.bits(16);
    reader.ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      if (reader.ue() === 3) reader.bit();
      reader.ue();
      reader.ue();
      reader.bit();
      if (reader.bit()) return undefined;
    }
    reader.ue();
    const pocType = reader.ue();
    if (pocType === 0) reader.ue();
    else if (pocType === 1) {
      reader.bit();
      reader.se();
      reader.se();
      for (let cycle = reader.ue(); cycle > 0; cycle--) reader.se();
    }
    const references = reader.ue();
    reader.bit();
    reader.ue();
    reader.ue();
    if (!reader.bit()) reader.bit();
    reader.bit();
    if (reader.bit()) { reader.ue(); reader.ue(); reader.ue(); reader.ue(); }
    if (reader.bit()) return undefined;
    const writer = new BitWriter();
    const retained = reader.position - 1;
    const copy = new BitReader(rbsp);
    for (let index = 0; index < retained; index++) writer.bit(copy.bit());
    writer.bit(1);
    // Aspect ratio, overscan, video signal, chroma location, timing, NAL and VCL HRD, and picture structure are absent.
    for (let index = 0; index < 8; index++) writer.bit(0);
    writer.bit(1);
    writer.bit(1);
    writer.ue(2);
    writer.ue(1);
    writer.ue(16);
    writer.ue(16);
    writer.ue(0);
    writer.ue(Math.max(1, references));
    writer.trailing();
    return Uint8Array.from([nal[0]!, ...escapeRbsp(writer.bytes)]);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * VideoToolbox's Baseline SPS has no VUI, so Chromium assumes up to 16
 * reordered frames and holds decoded output until later frames or a keyframe
 * arrive. Declaring decode order releases each frame as soon as it decodes.
 */
export function declareH264DecodeOrder(unit: Uint8Array): Uint8Array {
  const starts: Array<{ prefix: number; payload: number }> = [];
  for (let index = 0; index < unit.length - 3; index++) {
    if (unit[index] !== 0 || unit[index + 1] !== 0) continue;
    const length = unit[index + 2] === 1 ? 3 : unit[index + 2] === 0 && unit[index + 3] === 1 ? 4 : 0;
    if (!length || index + length >= unit.length) continue;
    starts.push({ prefix: index, payload: index + length });
    index += length - 1;
  }
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const end = starts[index + 1]?.prefix ?? unit.length;
    if ((unit[start.payload]! & 31) !== 7) continue;
    const sps = spsWithoutReordering(unit.subarray(start.payload, end));
    if (!sps) return unit;
    const output = new Uint8Array(unit.length - (end - start.payload) + sps.length);
    output.set(unit.subarray(0, start.payload));
    output.set(sps, start.payload);
    output.set(unit.subarray(end), start.payload + sps.length);
    return output;
  }
  return unit;
}

export async function preferredVideoCodec(): Promise<VideoCodec> {
  if (typeof VideoDecoder === "undefined" || typeof VideoDecoder.isConfigSupported !== "function") return "h264";
  try {
    const support = await VideoDecoder.isConfigSupported({ codec: provisionalCodec("hevc"), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    return support.supported ? "hevc" : "h264";
  } catch { return "h264"; }
}
