import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { LiveInput } from "./shared.js";
import { declareH264DecodeOrder, inspectVideoAccessUnit, provisionalCodec, type VideoCodec } from "./video-codec.js";

/** The helper encodes each frame the simulator renders, which is 60 Hz on current runtimes. */
export const VIDEO_FPS = 60;

export interface VideoStream {
  sessionId: string;
  url: string;
  codec: string;
  format: VideoCodec;
  fps: number;
  streamId?: string;
  maxDimension?: number;
}

export interface VideoBatch {
  sessionId: string;
  streamId: string;
  /** Batches are numbered in the order served, so a viewer can detect a lost or repeated batch. */
  sequence: number;
  frames: string[];
  active: true;
}

/** Native stdout is length-prefixed Annex B access units, independent of pipe chunk boundaries. */
export class AccessUnitReader {
  private buffered = Buffer.alloc(0);
  push(chunk: Buffer, consume: (unit: Buffer) => void) {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32BE(0);
      if (!size || size > 8 * 1024 * 1024) throw new Error("Invalid simulator video access unit.");
      if (this.buffered.length < size + 4) return;
      consume(this.buffered.subarray(4, size + 4));
      this.buffered = this.buffered.subarray(size + 4);
    }
  }
}

const INPUT_LAG_MS = 50;

/**
 * Replays viewer input with its original spacing so flick velocity survives
 * batching, while a late batch never adds more than INPUT_LAG_MS of delay.
 */
export class LiveInputPacer {
  private queue: Array<{ at: number; line: string }> = [];
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly write: (lines: string) => void, private readonly now = () => performance.now()) {}

  push(events: LiveInput[]) {
    const arrival = this.now();
    for (const event of events) {
      this.last = Math.max(this.last, Math.min(Math.max(arrival, this.last + event.dt), arrival + INPUT_LAG_MS));
      this.queue.push({ at: this.last, line: event.type === "home" ? "home\n" : `t ${event.type[0]} ${event.x.toFixed(5)} ${event.y.toFixed(5)}\n` });
    }
    this.drain();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
  }

  private drain() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    let lines = "";
    while (this.queue.length && this.queue[0]!.at <= now + 1) lines += this.queue.shift()!.line;
    if (lines) this.write(lines);
    if (this.queue.length) this.timer = setTimeout(() => this.drain(), this.queue[0]!.at - now);
  }
}

interface Channel {
  key: string;
  format: VideoCodec;
  sessionId: string;
  deviceId: string;
  maxDimension?: number;
  clients: Set<WebSocket>;
  waitingForKey: Set<WebSocket>;
  relays: Set<Relay>;
  process?: ChildProcessWithoutNullStreams;
  stderr: string;
  diagnostics: string;
  input?: { available: boolean; message?: string };
  pacer?: LiveInputPacer;
  keyframeRequestedAt?: number;
  heartbeat: ReturnType<typeof setInterval>;
  startup?: ReturnType<typeof setTimeout>;
}
interface Ticket { sessionId: string; deviceId: string; format: VideoCodec; maxDimension?: number; url: string; timer: ReturnType<typeof setTimeout> }
interface PendingRead { resolve: (batch: VideoBatch) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
interface Relay {
  format: VideoCodec;
  sessionId: string;
  streamId: string;
  channel: Channel;
  frames: Buffer[];
  bytes: number;
  waitingForKey: boolean;
  reads: PendingRead[];
  sequence: number;
  closed: boolean;
  error?: Error;
  idle?: ReturnType<typeof setTimeout>;
}

const RELAY_BYTES = 2 * 1024 * 1024;
const RELAY_FRAMES = 30;
const READ_WAIT_MS = 250;

function nativeFailure(stderr: string): string {
  for (const line of stderr.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as { event?: string; message?: string };
      if (event.event === "error" && typeof event.message === "string") return event.message;
    } catch { /* Non-JSON launch diagnostics remain useful to the viewer. */ }
  }
  return stderr.trim();
}

export interface SimulatorVideoOptions {
  helper?: URL;
  launch?: (deviceId: string, format: VideoCodec, options: { maxDimension?: number }) => ChildProcessWithoutNullStreams;
  keepAlive?: (sessionId: string) => void;
}

/** Viewers share an encoder per session, codec and size, with single-use capabilities. */
export class SimulatorVideo {
  private server?: Server;
  private sockets?: WebSocketServer;
  private listening?: Promise<string>;
  private readonly tickets = new Map<string, Ticket>();
  private readonly channels = new Map<string, Channel>();
  private readonly relays = new Map<string, Relay>();
  private closed = false;
  constructor(private readonly options: SimulatorVideoOptions = {}) {}

  origin(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("Simulator video is closed."));
    if (this.listening) return this.listening;
    this.listening = this.listen();
    return this.listening;
  }

  private async listen(): Promise<string> {
    const server = createServer((_request, response) => response.writeHead(404).end());
    const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
    this.server = server;
    this.sockets = sockets;
    server.on("upgrade", (request, socket, head) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const token = request.url?.match(/^\/video\/([a-f0-9]{48})$/)?.[1];
      const ticket = token ? this.tickets.get(token) : undefined;
      if (request.headers.host !== `127.0.0.1:${port}` || !ticket || this.closed) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      clearTimeout(ticket.timer);
      this.tickets.delete(token!);
      sockets.handleUpgrade(request, socket, head, client => this.watch(client, ticket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Simulator video did not bind to loopback.");
    return `ws://127.0.0.1:${address.port}`;
  }

  async stream(sessionId: string, deviceId: string, format: VideoCodec = "h264", maxDimension?: number): Promise<VideoStream> {
    const origin = await this.origin();
    if (this.closed) throw new Error("Simulator video is closed.");
    const token = randomBytes(24).toString("hex");
    const url = `${origin}/video/${token}`;
    const timer = setTimeout(() => this.tickets.delete(token), 30_000);
    timer.unref();
    this.tickets.set(token, { sessionId, deviceId, format, maxDimension, url, timer });
    return { sessionId, streamId: token, url, format, codec: provisionalCodec(format), fps: VIDEO_FPS, ...(maxDimension ? { maxDimension } : {}) };
  }

  /**
   * MCP app hosts read native access units without allowing loopback CSP. A
   * read returns as soon as frames are buffered, otherwise after READ_WAIT_MS.
   */
  async read(sessionId: string, streamId: string): Promise<VideoBatch> {
    if (this.closed) throw new Error("Simulator video is closed.");
    let relay = this.relays.get(streamId);
    if (!relay) {
      const ticket = this.tickets.get(streamId);
      if (!ticket || ticket.sessionId !== sessionId) throw new Error("Simulator video stream expired or is unavailable.");
      clearTimeout(ticket.timer);
      this.tickets.delete(streamId);
      relay = this.createRelay(ticket, streamId);
    }
    if (relay.sessionId !== sessionId) throw new Error("Simulator video stream belongs to another session.");
    if (relay.closed) throw relay.error ?? new Error("Simulator video stream stopped.");
    if (relay.reads.length) throw new Error("A simulator video read is already in progress for this stream.");
    const current = relay;
    this.armRelayIdle(current);
    if (current.waitingForKey) this.requestKeyframe(current.channel);
    return new Promise<VideoBatch>((resolve, reject) => {
      const read: PendingRead = {
        resolve, reject,
        timer: setTimeout(() => {
          const index = current.reads.indexOf(read);
          if (index < 0) return;
          current.reads.splice(index, 1);
          resolve(this.batch(current, []));
        }, READ_WAIT_MS),
      };
      current.reads.push(read);
      this.serve(current);
    });
  }

  stop(sessionId: string, streamId: string) {
    const ticket = this.tickets.get(streamId);
    if (ticket?.sessionId === sessionId) {
      clearTimeout(ticket.timer);
      this.tickets.delete(streamId);
    }
    const relay = this.relays.get(streamId);
    if (relay?.sessionId === sessionId) this.stopRelay(relay);
  }

  /** Sends touch and Home input through a running helper for the session, bypassing Xcode's event path. */
  input(sessionId: string, events: LiveInput[]) {
    if (this.closed) throw new Error("Simulator video is closed.");
    const running = [...this.channels.values()].filter(channel => channel.sessionId === sessionId && channel.process?.exitCode === null && channel.process.signalCode === null);
    const channel = running.find(candidate => candidate.input?.available !== false);
    if (!channel) {
      const unavailable = running.find(candidate => candidate.input?.available === false);
      throw new Error(unavailable ? `Live input is unavailable: ${unavailable.input!.message ?? "SimulatorKit rejected the connection."}` : "Live input needs running simulator video for this session.");
    }
    channel.pacer ??= new LiveInputPacer(lines => { if (channel.process?.stdin.writable) channel.process.stdin.write(lines); });
    channel.pacer.push(events);
    this.options.keepAlive?.(sessionId);
  }

  private batch(relay: Relay, frames: string[]): VideoBatch {
    return { sessionId: relay.sessionId, streamId: relay.streamId, sequence: relay.sequence++, frames, active: true };
  }

  private serve(relay: Relay) {
    if (!relay.frames.length || !relay.reads.length) return;
    const read = relay.reads.shift()!;
    clearTimeout(read.timer);
    const frames = relay.frames.map(frame => frame.toString("base64"));
    relay.frames = [];
    relay.bytes = 0;
    read.resolve(this.batch(relay, frames));
  }

  private deliver(relay: Relay, unit: Buffer, key: boolean) {
    if (relay.closed) return;
    if (unit.length > RELAY_BYTES) {
      if (key) this.stopRelay(relay, new Error("Simulator video keyframe exceeds the relay buffer limit."));
      else this.skipToKeyframe(relay);
      return;
    }
    // A reader that falls half a second behind resumes at a fresh keyframe instead of accumulating latency.
    if (relay.bytes + unit.length > RELAY_BYTES || relay.frames.length >= RELAY_FRAMES) this.skipToKeyframe(relay);
    if (relay.waitingForKey) {
      if (!key) return;
      relay.waitingForKey = false;
    }
    relay.frames.push(unit);
    relay.bytes += unit.length;
    this.serve(relay);
  }

  private skipToKeyframe(relay: Relay) {
    relay.frames = [];
    relay.bytes = 0;
    relay.waitingForKey = true;
    // An idle reader requests its keyframe when it next reads.
    if (relay.reads.length) this.requestKeyframe(relay.channel);
  }

  /** At most one request is outstanding; the helper otherwise sends keyframes only while the screen changes. */
  private requestKeyframe(channel: Channel) {
    const now = performance.now();
    if (!channel.process?.stdin.writable || (channel.keyframeRequestedAt !== undefined && now - channel.keyframeRequestedAt < 1000)) return;
    channel.keyframeRequestedAt = now;
    channel.process.stdin.write("k\n");
  }

  private createRelay(ticket: Ticket, streamId: string): Relay {
    const channel = this.channelFor(ticket);
    const relay: Relay = {
      sessionId: ticket.sessionId, format: ticket.format, streamId, channel,
      frames: [], bytes: 0, waitingForKey: true, reads: [], sequence: 0, closed: false,
    };
    this.relays.set(streamId, relay);
    channel.relays.add(relay);
    this.armRelayIdle(relay);
    this.startCapture(channel);
    return relay;
  }

  private armRelayIdle(relay: Relay) {
    clearTimeout(relay.idle);
    relay.idle = setTimeout(() => this.stopRelay(relay, new Error("Simulator video stream expired after idle timeout.")), 10_000);
    relay.idle.unref();
  }

  private stopRelay(relay: Relay, error?: Error) {
    if (relay.closed) return;
    relay.closed = true;
    relay.error = error;
    clearTimeout(relay.idle);
    relay.frames = [];
    relay.bytes = 0;
    this.relays.delete(relay.streamId);
    for (const read of relay.reads.splice(0)) {
      clearTimeout(read.timer);
      read.reject(error ?? new Error("Simulator video stream stopped."));
    }
    const channel = relay.channel;
    channel.relays.delete(relay);
    if (!channel.clients.size && !channel.relays.size) this.stopChannel(channel);
  }

  private channelFor(ticket: Ticket): Channel {
    const key = `${ticket.sessionId}:${ticket.format}${ticket.maxDimension ? `:${ticket.maxDimension}` : ""}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        key, format: ticket.format, sessionId: ticket.sessionId, deviceId: ticket.deviceId, maxDimension: ticket.maxDimension,
        clients: new Set(), waitingForKey: new Set(), relays: new Set(), stderr: "", diagnostics: "",
        heartbeat: setInterval(() => {
          if (channel) {
            this.options.keepAlive?.(channel.sessionId);
            for (const socket of channel.clients) if (socket.readyState === WebSocket.OPEN) socket.ping();
          }
        }, 10_000),
      };
      channel.heartbeat.unref();
      this.channels.set(key, channel);
    }
    return channel;
  }

  private startCapture(channel: Channel) {
    this.options.keepAlive?.(channel.sessionId);
    if (channel.process) { this.requestKeyframe(channel); return; }
    try { this.capture(channel); }
    catch (error) { this.fail(channel, `Could not start simulator video: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private watch(client: WebSocket, ticket: Ticket) {
    const current = this.channelFor(ticket);
    current.clients.add(client);
    current.waitingForKey.add(client);
    // Video is receive-only; controls continue through typed MCP tools.
    client.on("message", () => client.close(1008, "Video connection is receive-only."));
    client.on("error", () => client.terminate());
    client.once("close", () => {
      this.releaseClient(current, client);
    });
    let alive = true;
    client.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) client.terminate();
      alive = false;
    }, 20_000);
    heartbeat.unref();
    client.once("close", () => clearInterval(heartbeat));
    this.startCapture(current);
  }

  private capture(channel: Channel) {
    const helper = this.options.helper ?? new URL("../plugins/apple-device-hub/dist/simulator-stream", import.meta.url);
    const sizing = channel.maxDimension ? ["--max-dimension", String(channel.maxDimension)] : [];
    const process = this.options.launch
      ? this.options.launch(channel.deviceId, channel.format, { maxDimension: channel.maxDimension })
      : spawn(fileURLToPath(helper), [channel.deviceId, "--codec", channel.format, ...sizing], { stdio: ["pipe", "pipe", "pipe"] });
    channel.process = process;
    // The helper's first frame is a keyframe.
    channel.keyframeRequestedAt = performance.now();
    process.stdin.on("error", () => {});
    const reader = new AccessUnitReader();
    channel.startup = setTimeout(() => this.fail(channel, "Simulator produced no video frames. Check the selected Xcode and booted simulator."), 15_000);
    channel.startup.unref();
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      channel.stderr = (channel.stderr + text).slice(-3000);
      const lines = (channel.diagnostics + text).split("\n");
      channel.diagnostics = lines.pop()!.slice(-3000);
      for (const line of lines) this.diagnostic(channel, line);
    });
    process.stdout.on("data", (chunk: Buffer) => {
      if (this.channels.get(channel.key) !== channel) return;
      try {
        reader.push(chunk, encoded => {
          clearTimeout(channel.startup);
          channel.startup = undefined;
          const frame = inspectVideoAccessUnit(encoded, channel.format);
          const key = frame.keyFrame && frame.hasParameterSets;
          const unit = key && channel.format === "h264" ? Buffer.from(declareH264DecodeOrder(encoded)) : encoded;
          if (key) channel.keyframeRequestedAt = undefined;
          for (const client of channel.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            // Closing preserves dependency order; the viewer reconnects at a new keyframe.
            if (client.bufferedAmount > 512 * 1024) {
              client.close(1013, "Simulator video viewer is too slow.");
              this.releaseClient(channel, client);
              continue;
            }
            if (channel.waitingForKey.has(client)) {
              if (!key) continue;
              channel.waitingForKey.delete(client);
            }
            client.send(unit, { binary: true });
          }
          for (const relay of channel.relays) this.deliver(relay, unit, key);
        });
      } catch (error) { this.fail(channel, String(error)); }
    });
    process.once("error", error => this.fail(channel, `Could not start simulator video: ${error.message}`));
    // `close` runs after stdout/stderr drain, preserving the helper's final diagnostic.
    process.once("close", (code, signal) => {
      if (this.channels.get(channel.key) === channel) this.fail(channel, nativeFailure(channel.stderr) || `Simulator video stopped (${signal ?? code}).`);
    });
  }

  private diagnostic(channel: Channel, line: string) {
    try {
      const event = JSON.parse(line) as { event?: string; available?: unknown; message?: unknown };
      if (event.event === "input" && typeof event.available === "boolean") {
        channel.input = { available: event.available, ...(typeof event.message === "string" ? { message: event.message } : {}) };
      }
    } catch { /* Non-JSON output is kept only for failure messages. */ }
  }

  private fail(channel: Channel, message: string) {
    if (this.channels.get(channel.key) !== channel) return;
    for (const client of channel.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message }));
    }
    for (const relay of channel.relays) this.stopRelay(relay, new Error(message));
    this.stopChannel(channel);
  }

  private releaseClient(channel: Channel, client: WebSocket) {
    channel.clients.delete(client);
    channel.waitingForKey.delete(client);
    if (!channel.clients.size && !channel.relays.size) this.stopChannel(channel);
  }

  private stopChannel(channel: Channel) {
    if (this.channels.get(channel.key) !== channel) return;
    this.channels.delete(channel.key);
    clearInterval(channel.heartbeat);
    clearTimeout(channel.startup);
    channel.pacer?.close();
    for (const client of channel.clients) client.close(1000, "Simulator video stopped.");
    for (const relay of channel.relays) this.stopRelay(relay);
    const process = channel.process;
    if (process && process.exitCode === null) {
      process.stdin.end();
      process.kill("SIGTERM");
      const kill = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }, 2000);
      kill.unref();
      process.once("exit", () => clearTimeout(kill));
    }
  }

  closeSession(sessionId: string) {
    for (const relay of this.relays.values()) if (relay.sessionId === sessionId) this.stopRelay(relay);
    for (const [token, ticket] of this.tickets) {
      if (ticket.sessionId === sessionId) { clearTimeout(ticket.timer); this.tickets.delete(token); }
    }
    for (const channel of this.channels.values()) if (channel.sessionId === sessionId) this.stopChannel(channel);
  }

  async close() {
    this.closed = true;
    for (const ticket of this.tickets.values()) clearTimeout(ticket.timer);
    this.tickets.clear();
    for (const relay of this.relays.values()) this.stopRelay(relay);
    for (const channel of this.channels.values()) this.stopChannel(channel);
    for (const client of this.sockets?.clients ?? []) client.terminate();
    this.sockets?.close();
    if (this.listening) await this.listening.catch(() => {});
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
