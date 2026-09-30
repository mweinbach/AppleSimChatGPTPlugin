import assert from "node:assert/strict";
import test from "node:test";
import { inspectVideoAccessUnit } from "../src/video-codec.js";

// Main profile, compatibility flags 0x60000000, level 150, constraints B0.
// Emulation prevention bytes must not shift the profile_tier_level fields.
export const hevcKeyframe = Buffer.from([
  0, 0, 0, 1, 0x40, 1, 0xaa,
  0, 0, 1, 0x42, 1, 1, 1, 0x60, 0, 0, 3, 0, 0xb0, 0, 0, 3, 0, 0, 3, 0, 0x96,
  0, 0, 0, 1, 0x44, 1, 0xbb,
  0, 0, 1, 0x26, 1, 0xcc,
]);

test("HEVC Annex B extracts the SPS identity and requires VPS, SPS, PPS with an IRAP picture", () => {
  assert.deepEqual(inspectVideoAccessUnit(hevcKeyframe, "hevc"), { keyFrame: true, hasPicture: true, hasParameterSets: true, codec: "hev1.1.6.L150.B0" });
  assert.equal(inspectVideoAccessUnit(hevcKeyframe.subarray(7), "hevc").hasParameterSets, false);
  for (const type of [16, 17, 18, 19, 20, 21]) assert.equal(inspectVideoAccessUnit(Buffer.from([0, 0, 1, type << 1, 1, 0xcc]), "hevc").keyFrame, true);
  assert.deepEqual(inspectVideoAccessUnit(Buffer.from([0, 0, 1, 2, 1, 0xcc]), "hevc"), { keyFrame: false, hasPicture: true, hasParameterSets: false, codec: undefined });
  assert.equal(inspectVideoAccessUnit(Buffer.from([0, 0, 1, 0x46, 1, 0xaa]), "hevc").hasPicture, false);
});
