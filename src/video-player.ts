import { inspectVideoAccessUnit, type VideoCodec } from "./video-codec.js";

export interface SimulatorStream {
  sessionId: string;
  url: string;
  codec: string;
  fps: number;
  streamId?: string;
  format?: VideoCodec;
}

export interface SimulatorVideoTransport {
  /** One item is one Annex B access unit; reads wait for a bounded video batch. */
  read(): Promise<Uint8Array[]>;
  stop(): void;
}

/** One access unit carries SPS/PPS on IDR frames. */
export function inspectH264AccessUnit(data: Uint8Array) {
  return inspectVideoAccessUnit(data, "h264");
}

export function coordinateSpaceMatchesFrame(space: { width: number; height: number }, frame: { width: number; height: number }) {
  if (!space.width || !space.height || !frame.width || !frame.height) return false;
  const screenRatio = space.width / space.height;
  const frameRatio = frame.width / frame.height;
  return Math.abs(screenRatio - frameRatio) / Math.max(screenRatio, frameRatio) < 0.02;
}

/** Owns the transport and decoder; stopping releases native capture. */
export class SimulatorVideoPlayer {
  private socket: WebSocket | undefined;
  private decoder: VideoDecoder | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private resumeDecode: (() => void) | undefined;
  private stopped = false;
  private waitingForKey = true;
  private codec: string;
  private timestamp = 0;
  private readonly context: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stream: SimulatorStream,
    private readonly onFrame: (dimensions: { width: number; height: number }) => void,
    private readonly onError: (error: Error) => void,
    private readonly transport?: SimulatorVideoTransport,
  ) {
    this.codec = stream.codec;
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") throw new Error("This viewer does not support live simulator video. Open it in a browser with WebCodecs support.");
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context) throw new Error("The viewer could not create a video canvas.");
    this.context = context;
  }

  start() {
    if (this.stopped || this.decoder || this.socket) return;
    try {
      this.decoder = new VideoDecoder({
        output: frame => {
          try {
            if (this.stopped) return;
            if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
              this.canvas.width = frame.displayWidth;
              this.canvas.height = frame.displayHeight;
            }
            this.context.drawImage(frame, 0, 0);
            this.onFrame({ width: frame.displayWidth, height: frame.displayHeight });
            if (!this.stopped) this.armWatchdog(5000);
          } catch (error) {
            this.fail(error);
          } finally {
            frame.close();
          }
        },
        error: error => this.fail(new Error(`Live video decoder failed: ${error.message}`)),
      });
      // Native startup has a 15-second timeout and can report a more useful error.
      this.armWatchdog(20_000);
      if (this.transport) {
        void this.readFrames();
        return;
      }
      const socket = new WebSocket(this.stream.url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = event => {
        if (this.stopped) return;
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as { type?: string; message?: string };
            if (message.type === "error") this.fail(new Error(message.message || "Native simulator capture failed."));
          } catch (error) { this.fail(error); }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        try { this.decode(new Uint8Array(event.data)); } catch (error) { this.fail(error); }
      };
      socket.onerror = () => this.fail(new Error("Could not connect to the local simulator video stream."));
      socket.onclose = () => { if (!this.stopped) this.fail(new Error("The simulator video stream disconnected.")); };
    } catch (error) { this.fail(error); }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.watchdog !== undefined) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.resumeDecode?.();
    this.transport?.stop();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
  }

  private configure() {
    // Omitting description selects Annex B. avc.format belongs to VideoEncoder.
    this.decoder!.configure({ codec: this.codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
    this.waitingForKey = true;
  }

  private async readFrames() {
    try {
      while (!this.stopped) {
        const frames = await this.transport!.read();
        if (this.stopped) return;
        for (const frame of frames) {
          if (this.stopped) return;
          if (this.decoder!.decodeQueueSize >= 4) await this.waitForDecoder();
          if (this.stopped) return;
          this.decode(frame);
        }
      }
    } catch (error) { this.fail(error); }
  }

  private waitForDecoder() {
    const decoder = this.decoder!;
    return new Promise<void>(resolve => {
      const ready = () => { if (decoder.decodeQueueSize < 4) finish(); };
      const finish = () => {
        decoder.removeEventListener("dequeue", ready);
        this.resumeDecode = undefined;
        resolve();
      };
      this.resumeDecode = finish;
      decoder.addEventListener("dequeue", ready);
      ready();
    });
  }

  private decode(data: Uint8Array) {
    const decoder = this.decoder!;
    const unit = inspectVideoAccessUnit(data, this.stream.format ?? "h264");
    if (!unit.hasPicture) return;
    if (unit.codec && unit.codec !== this.codec) {
      this.codec = unit.codec;
      if (decoder.state === "configured") decoder.reset();
      this.waitingForKey = true;
    }
    // A slow renderer catches up at the next IDR instead of accumulating latency.
    if (decoder.decodeQueueSize > 4) {
      decoder.reset();
      this.waitingForKey = true;
    }
    if (this.waitingForKey && (!unit.keyFrame || !unit.hasParameterSets)) return;
    // The descriptor codec is provisional; configure from the actual SPS only
    // once a complete keyframe can start decoding.
    if (decoder.state === "unconfigured") this.configure();
    this.waitingForKey = false;
    decoder.decode(new EncodedVideoChunk({ type: unit.keyFrame ? "key" : "delta", timestamp: this.timestamp, data }));
    this.timestamp += Math.round(1_000_000 / this.stream.fps);
  }

  private armWatchdog(delay: number) {
    if (this.watchdog !== undefined) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(new Error("The simulator stopped producing live video frames.")), delay);
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    this.stop();
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
