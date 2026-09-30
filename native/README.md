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
pixels for both codecs. `--codec hevc` requires VideoToolbox hardware encoding;
`--codec h264` (the helper's default) prefers hardware and can use software.
The viewer probes HEVC decoding support and retries with a separate H.264 stream
if HEVC capture or decoding fails.

The helper reads the primary screen's IOSurface from CoreSimulator screen
callbacks and samples its changing pixels at 30 fps. It creates owned frame
buffers before asynchronous VideoToolbox encoding. Two frames may be in flight;
timer ticks skip when the encoder or output is busy. Output remains bounded when
the consumer stops reading. UI orientation and changing surface dimensions
reconfigure the encoder and produce new codec parameters.

Standard output contains only binary records:

```
[4-byte unsigned big-endian payload length][HEVC or H.264 Annex B access unit]
```

Each access unit contains one encoded frame. Every keyframe carries SPS and PPS
(plus VPS for HEVC) before its video NAL units, with four-byte Annex B start codes. A
keyframe is requested once per 30 submitted frames. Codec names must be derived
from the SPS rather than assumed. The HEVC configuration diagnostic identifies
the codec family; the viewer derives the full RFC 6381 identity from its SPS.

HEVC uses Main profile and a target bitrate of `max(width × height × 1.8, 1.2 Mbps)`.
H.264 uses Baseline and `max(width × height × 3, 2 Mbps)`. Both are realtime,
disable frame reordering, and limit encoder frame delay to one frame.

Encoder callbacks serialize each entire output record, so stdout backpressure
cannot interleave a frame's length header with another frame's payload. NAL
lengths come from each frame's CoreMedia format, including delta frames; an
incomplete NAL header or payload is a capture failure.

Standard error contains newline-separated JSON diagnostic events. Configuration
events include `width`, `height`, `sourceWidth`, `sourceHeight`, `orientation`,
`fps`, `codec`, and `hardwareAccelerated`. The hardware flag is read from
VideoToolbox. HEVC creation requires hardware; H.264 can use a software encoder
on unsupported hosts.

SIGINT, SIGTERM, and a closed output pipe unregister this helper's unique screen
callback, cancel its timer, release its buffers, and invalidate its encoder. They
do not disconnect, stop, or alter the simulator. A consumer should discard an
incomplete final record when its stream ends.

This is an original capture and video-encoding implementation informed by
[KittyFarm's CoreSimulator IOSurface technique](https://github.com/dnakov/kittyfarm/blob/2ac05cc96551a949282f04059832d923d676ff4f/KittyFarm/PrivateSimulator/DFPrivateSimulatorDisplayBridge.m).
It uses the raw screen descriptors already exposed by `SimDevice.io.ioPorts` and
does not embed KittyFarm's SimulatorKit bridge, app, or accessibility runner.

`node --import tsx --test test/native-video.test.ts` compiles a temporary CoreMedia
fixture against the helper's actual output method. It checks 1-, 2-, and 4-byte
AVCC NAL lengths, sync attachments, malformed samples, and concurrent output.
It does not connect to a simulator or require a booted device.
