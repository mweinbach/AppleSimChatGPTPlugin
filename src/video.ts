import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { inspectVideoAccessUnit, provisionalCodec, type VideoCodec } from "./video-codec.js";

export interface VideoStream {
  sessionId: string;
  url: string;
  codec: string;
  format: VideoCodec;
  fps: number;
  streamId?: string;
}

export interface VideoBatch {
  sessionId: string;
  streamId: string;
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

interface Channel {
  key: string;
  format: VideoCodec;
  sessionId: string;
  deviceId: string;
  clients: Set<WebSocket>;
  waitingForKey: Set<WebSocket>;
  process?: ChildProcessWithoutNullStreams;
  stderr: string;
  heartbeat: ReturnType<typeof setInterval>;
  startup?: ReturnType<typeof setTimeout>;
}
interface Ticket { sessionId: string; deviceId: string; format: VideoCodec; url: string; timer: ReturnType<typeof setTimeout> }
interface Relay {
  format: VideoCodec;
  sessionId: string;
  streamId: string;
  socket: WebSocket;
  frames: Buffer[];
  bytes: number;
  waitingForKey: boolean;
  reading: boolean;
  closed: boolean;
  error?: Error;
  idle?: ReturnType<typeof setTimeout>;
  finishRead?: () => void;
}

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
  launch?: (deviceId: string, format: VideoCodec) => ChildProcessWithoutNullStreams;
  keepAlive?: (sessionId: string) => void;
}

/** Viewers share an encoder per session and codec, with single-use capabilities. */
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

  async stream(sessionId: string, deviceId: string, format: VideoCodec = "h264"): Promise<VideoStream> {
    const origin = await this.origin();
    if (this.closed) throw new Error("Simulator video is closed.");
    const token = randomBytes(24).toString("hex");
    const url = `${origin}/video/${token}`;
    const timer = setTimeout(() => this.tickets.delete(token), 30_000);
    timer.unref();
    this.tickets.set(token, { sessionId, deviceId, format, url, timer });
    return { sessionId, streamId: token, url, format, codec: provisionalCodec(format), fps: 30 };
  }

  /** MCP app hosts read native access units without allowing loopback CSP. */
  async read(sessionId: string, streamId: string): Promise<VideoBatch> {
    if (this.closed) throw new Error("Simulator video is closed.");
    let relay = this.relays.get(streamId);
    if (!relay) {
      const ticket = this.tickets.get(streamId);
      if (!ticket || ticket.sessionId !== sessionId) throw new Error("Simulator video stream expired or is unavailable.");
      relay = this.createRelay(ticket, streamId);
    }
    if (relay.sessionId !== sessionId) throw new Error("Simulator video stream belongs to another session.");
    if (relay.reading) throw new Error("A simulator video read is already in progress for this stream.");
    relay.reading = true;
    this.armRelayIdle(relay);
    try {
      const current = relay;
      await new Promise<void>(resolve => {
        const timer = setTimeout(finish, 150);
        function finish() {
          clearTimeout(timer);
          current.finishRead = undefined;
          resolve();
        }
        current.finishRead = finish;
        if (current.closed) finish();
      });
      if (relay.error) throw relay.error;
      if (relay.closed) throw new Error("Simulator video stream stopped.");
      const frames = relay.frames.map(frame => frame.toString("base64"));
      relay.frames = [];
      relay.bytes = 0;
      return { sessionId, streamId, frames, active: true };
    } finally {
      relay.reading = false;
      if (!relay.closed) this.armRelayIdle(relay);
    }
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

  private createRelay(ticket: Ticket, streamId: string): Relay {
    const socket = new WebSocket(ticket.url);
    const relay: Relay = {
      sessionId: ticket.sessionId, format: ticket.format, streamId, socket,
      frames: [], bytes: 0, waitingForKey: true, reading: false, closed: false,
    };
    this.relays.set(streamId, relay);
    socket.on("message", (data, binary) => {
      if (relay.closed) return;
      if (!binary) {
        try {
          const event = JSON.parse(data.toString()) as { type?: string; message?: string };
          if (event.type === "error") this.stopRelay(relay, new Error(event.message || "Native simulator capture failed."));
        } catch { this.stopRelay(relay, new Error("Simulator video returned an invalid diagnostic.")); }
        return;
      }
      const frame = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      const unit = inspectVideoAccessUnit(frame, relay.format);
      const key = unit.keyFrame && unit.hasParameterSets;
      if (frame.length > 2 * 1024 * 1024) {
        if (key) this.stopRelay(relay, new Error("Simulator video keyframe exceeds the relay buffer limit."));
        else { relay.frames = []; relay.bytes = 0; relay.waitingForKey = true; }
        return;
      }
      // Preserve complete dependency chains, keeping at most one GOP and 2 MiB.
      if (relay.bytes + frame.length > 2 * 1024 * 1024 || relay.frames.length >= 30) {
        relay.frames = [];
        relay.bytes = 0;
        relay.waitingForKey = true;
      }
      if (relay.waitingForKey) {
        if (!key) return;
        relay.waitingForKey = false;
      }
      relay.frames.push(frame);
      relay.bytes += frame.length;
    });
    socket.on("error", error => this.stopRelay(relay, new Error(`Could not connect to simulator video: ${error.message}`)));
    socket.on("close", () => { if (!relay.closed) this.stopRelay(relay, new Error("Simulator video stream disconnected.")); });
    this.armRelayIdle(relay);
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
    relay.socket.terminate();
    relay.finishRead?.();
  }

  private watch(client: WebSocket, ticket: Ticket) {
    const key = `${ticket.sessionId}:${ticket.format}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        key, format: ticket.format, sessionId: ticket.sessionId, deviceId: ticket.deviceId,
        clients: new Set(), waitingForKey: new Set(), stderr: "",
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
    const current = channel;
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
    this.options.keepAlive?.(current.sessionId);
    if (!current.process) {
      try { this.capture(current); }
      catch (error) { this.fail(current, `Could not start simulator video: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private capture(channel: Channel) {
    const helper = this.options.helper ?? new URL("../plugins/apple-device-hub/dist/simulator-stream", import.meta.url);
    const process = this.options.launch ? this.options.launch(channel.deviceId, channel.format) : spawn(fileURLToPath(helper), [channel.deviceId, "--codec", channel.format], { stdio: ["pipe", "pipe", "pipe"] });
    channel.process = process;
    process.stdin.end();
    const reader = new AccessUnitReader();
    channel.startup = setTimeout(() => this.fail(channel, "Simulator produced no video frames. Check the selected Xcode and booted simulator."), 15_000);
    channel.startup.unref();
    process.stderr.on("data", (chunk: Buffer) => { channel.stderr = (channel.stderr + chunk.toString()).slice(-3000); });
    process.stdout.on("data", (chunk: Buffer) => {
      if (this.channels.get(channel.key) !== channel) return;
      try {
        reader.push(chunk, unit => {
          clearTimeout(channel.startup);
          channel.startup = undefined;
          const frame = inspectVideoAccessUnit(unit, channel.format);
          for (const client of channel.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            // Closing preserves dependency order; the viewer reconnects at a new keyframe.
            if (client.bufferedAmount > 512 * 1024) {
              client.close(1013, "Simulator video viewer is too slow.");
              this.releaseClient(channel, client);
              continue;
            }
            if (channel.waitingForKey.has(client)) {
              if (!frame.keyFrame || !frame.hasParameterSets) continue;
              channel.waitingForKey.delete(client);
            }
            client.send(unit, { binary: true });
          }
        });
      } catch (error) { this.fail(channel, String(error)); }
    });
    process.once("error", error => this.fail(channel, `Could not start simulator video: ${error.message}`));
    // `close` runs after stdout/stderr drain, preserving the helper's final diagnostic.
    process.once("close", (code, signal) => {
      if (this.channels.get(channel.key) === channel) this.fail(channel, nativeFailure(channel.stderr) || `Simulator video stopped (${signal ?? code}).`);
    });
  }

  private fail(channel: Channel, message: string) {
    if (this.channels.get(channel.key) !== channel) return;
    for (const client of channel.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message }));
    }
    this.stopChannel(channel);
  }

  private releaseClient(channel: Channel, client: WebSocket) {
    channel.clients.delete(client);
    channel.waitingForKey.delete(client);
    if (!channel.clients.size) this.stopChannel(channel);
  }

  private stopChannel(channel: Channel) {
    if (this.channels.get(channel.key) !== channel) return;
    this.channels.delete(channel.key);
    clearInterval(channel.heartbeat);
    clearTimeout(channel.startup);
    for (const client of channel.clients) client.close(1000, "Simulator video stopped.");
    const process = channel.process;
    if (process && process.exitCode === null) {
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
