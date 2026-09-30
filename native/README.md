# Simulator video helper

`node scripts/build-native.mjs` compiles and ad hoc signs
`plugins/apple-device-hub/dist/simulator-stream` using the selected Xcode.

```sh
plugins/apple-device-hub/dist/simulator-stream <simulator-UDID> \
  --codec hevc \
  --developer-dir /Applications/Xcode.app/Contents/Developer
```

The simulator must already be booted. `--developer-dir` is optional and otherwise
uses `DEVELOPER_DIR` or `xcode-select -p`. `--max-dimension 1920` optionally scales
the longest output edge to 1920 pixels while preserving aspect ratio. The default
preserves the simulator's resolution. Encoded dimensions are rounded down to even
pixels for both codecs. `--max-fps` caps the encoded frame rate (default 120).
`--codec hevc` requires VideoToolbox hardware encoding; `--codec h264` (the
helper's default) prefers hardware and can use software. The viewer probes HEVC
decoding support and retries with a separate H.264 stream if HEVC capture or
decoding fails.

The helper reads the primary screen's IOSurface from CoreSimulator screen
callbacks and encodes a frame each time the simulator renders a changed frame,
so the stream follows the simulator's own rate (60 fps on current iOS runtimes)
rather than a fixed timer. A static screen is re-encoded once per second, which
keeps viewers' liveness checks satisfied without re-sending unchanged pixels.
The helper creates owned frame buffers before asynchronous VideoToolbox encoding.
Two frames may be in flight; a frame that arrives while both are busy is encoded
when one returns, so the last frame of an animation is never dropped. Output
remains bounded when the consumer stops reading. UI orientation and changing
surface dimensions reconfigure the encoder and produce new codec parameters.

Standard output contains only binary records:

```
[4-byte unsigned big-endian payload length][HEVC or H.264 Annex B access unit]
```

Each access unit contains one encoded frame. Every keyframe carries SPS and PPS
(plus VPS for HEVC) before its video NAL units, with four-byte Annex B start codes.
Keyframes are sent first, on request, and every two seconds while the screen is
changing. Codec names must be derived from the SPS rather than assumed. The HEVC
configuration diagnostic identifies the codec family; the viewer derives the full
RFC 6381 identity from its SPS. VideoToolbox's H.264 SPS declares no frame
reordering limit, so the server adds one before relaying; see `declareH264DecodeOrder`.

HEVC uses Main profile and a target bitrate of `max(width × height × 2.4, 1.6 Mbps)`.
H.264 uses Baseline and `max(width × height × 4, 2.6 Mbps)`. Both are realtime,
prioritize encoding speed, disable frame reordering, and allow no encoder frame delay.

Standard input accepts newline-separated commands:

| Command | Effect |
| --- | --- |
| `k` | Encode the current screen as a keyframe now. |
| `t d <x> <y>` | Touch down. |
| `t m <x> <y>` | Move a touch that is down; starts one if none is. |
| `t u <x> <y>`, `t c <x> <y>` | Lift the touch. |
| `home` | Press and release the Home button. |

Touch coordinates are fractions of the most recently encoded frame, which is
upright, and are rotated back to the display surface before delivery. Input goes
through SimulatorKit's `SimDeviceLegacyHIDClient` as Indigo HID messages, the
same path Simulator.app's digitizer uses, and bypasses Xcode's event synthesizer.
The helper does not pace input; the server replays viewer timing.

Encoder callbacks serialize each entire output record, so stdout backpressure
cannot interleave a frame's length header with another frame's payload. NAL
lengths come from each frame's CoreMedia format, including delta frames; an
incomplete NAL header or payload is a capture failure.

Standard error contains newline-separated JSON diagnostic events. Configuration
events include `width`, `height`, `sourceWidth`, `sourceHeight`, `orientation`,
`fps`, `codec`, and `hardwareAccelerated`. The hardware flag is read from
VideoToolbox. HEVC creation requires hardware; H.264 can use a software encoder
on unsupported hosts. An `input` event reports whether touch input is `available`,
with a `message` when it is not; video continues either way. `input-error` events
report individual input failures. The `stopped` event includes frame and keyframe
counts and the average and maximum encode latency.

SIGINT, SIGTERM, and a closed output pipe lift any held touch, unregister this
helper's unique screen callback, cancel its timer, release its buffers, and
invalidate its encoder. They do not disconnect, stop, or alter the simulator. A
consumer should discard an incomplete final record when its stream ends.

This is an original capture, encoding and input implementation informed by
[KittyFarm's CoreSimulator IOSurface technique](https://github.com/dnakov/kittyfarm/blob/2ac05cc96551a949282f04059832d923d676ff4f/KittyFarm/PrivateSimulator/DFPrivateSimulatorDisplayBridge.m)
and its Indigo touch packet layout. It uses the raw screen descriptors already
exposed by `SimDevice.io.ioPorts` and does not embed KittyFarm's bridge, app, or
accessibility runner. SimulatorKit is loaded from the selected Xcode's
`SharedFrameworks` or, for older releases, `Library/PrivateFrameworks`.

`node --import tsx --test test/native-video.test.ts` compiles a temporary CoreMedia
fixture against the helper's actual output method. It checks 1-, 2-, and 4-byte
AVCC NAL lengths, sync attachments, malformed samples, and concurrent output.
It does not connect to a simulator or require a booted device.
`node --import tsx scripts/interaction-benchmark.mjs <UDID> [hevc|h264] [--max-dimension <pixels>]`
drives a real HID drag on a booted simulator and reports the encoded frame rate,
bandwidth, encode latency and input-to-frame latency.
