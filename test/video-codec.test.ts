import assert from "node:assert/strict";
import test from "node:test";
import { declareH264DecodeOrder, inspectVideoAccessUnit } from "../src/video-codec.js";

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

test("H.264 keyframes declare decode order so hardware decoders release each frame", () => {
  // VideoToolbox Baseline SPS for 470 × 1024 without VUI, followed by its PPS and IDR slice.
  const sps = "27420020ab40f0103cda", rest = "00000001" + "28ce3c80" + "00000001" + "65888421";
  const unit = Buffer.from("00000001" + sps + rest, "hex");
  const declared = Buffer.from(declareH264DecodeOrder(unit));
  // Adds VUI with only bitstream_restriction: max_num_reorder_frames 0, max_dec_frame_buffering 1.
  assert.equal(declared.toString("hex"), "00000001" + "27420020ab40f0103cdc03682211a8" + rest);
  assert.deepEqual(inspectVideoAccessUnit(declared), inspectVideoAccessUnit(unit));
  assert.deepEqual(Buffer.from(declareH264DecodeOrder(declared)), declared, "an SPS with VUI is left unchanged");
  const delta = Buffer.from("0000000141" + "9a2461", "hex");
  assert.equal(declareH264DecodeOrder(delta), delta);
  // Truncated or scaling-list SPS data is passed through rather than guessed at.
  for (const unsafe of ["0000000127420020", "000000012764001fad80" + rest]) {
    const input = Buffer.from(unsafe, "hex");
    assert.equal(declareH264DecodeOrder(input), input);
  }
});
