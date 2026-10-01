import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';

/** A Device Hub server process holding an Xcode device session. */
export interface SessionHolder { pid: number; sessionId: string; since: string }
export interface SharedSession {
  key: string;
  deviceId: string;
  deviceName: string;
  /** Started by a tool other than Device Hub, which Device Hub never ends. */
  foreign?: boolean;
  holders: SessionHolder[];
}
/** The device a Device Hub process connected most recently; viewers follow it. */
export interface RegistryFocus { deviceId: string; deviceName: string; pid: number; at: string }
interface RegistryState { boot: number; sessions: Record<string, SharedSession>; created: string[]; focus?: RegistryFocus }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Xcode allows one interaction session per device, and any process that
 * knows a session's key can use or end it. Each chat or window runs its own
 * Device Hub server, so the servers record which of them hold each session in
 * a per-user file: they share a device, and only the last to leave ends it.
 */
export class SessionRegistry {
  // Hosts launch MCP servers with different environments, some without TMPDIR,
  // so the shared file lives under the home directory every server can find.
  constructor(private readonly directory = join(homedir(), 'Library', 'Caches', 'apple-device-hub'), private readonly pid = process.pid) {}

  private get file() { return join(this.directory, 'sessions.json'); }

  private async read(): Promise<RegistryState> {
    let state: Partial<RegistryState>;
    try { state = JSON.parse(await readFile(this.file, 'utf8')) as Partial<RegistryState>; }
    catch { state = {}; }
    // Xcode sessions and process IDs end with the boot; created simulators do not.
    const boot = Date.now() - uptime() * 1000;
    const sameBoot = typeof state.boot === 'number' && Math.abs(state.boot - boot) < 120_000;
    const sessions: Record<string, SharedSession> = {};
    for (const [key, session] of Object.entries(sameBoot ? state.sessions ?? {} : {})) {
      // A crashed server leaves its hold behind; the device stays usable by whoever joins next.
      const holders = (session.holders ?? []).filter(holder => alive(holder.pid));
      if (holders.length) sessions[key] = { ...session, holders };
    }
    return { boot: sameBoot ? state.boot! : boot, sessions, created: state.created ?? [], ...(sameBoot && state.focus ? { focus: state.focus } : {}) };
  }

  private async update<T>(change: (state: RegistryState) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'sessions.lock');
    for (let attempt = 0; ; attempt++) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A server that exited mid-update leaves its lock behind.
        const age = Date.now() - ((await stat(lock).catch(() => undefined))?.mtimeMs ?? Date.now());
        if (age > 2000 || attempt > 300) await rm(lock, { recursive: true, force: true });
        else await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try {
      const state = await this.read();
      const result = change(state);
      const temporary = `${this.file}.${this.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.file);
      return result;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async find(key: string): Promise<SharedSession | undefined> {
    return (await this.read()).sessions[key];
  }

  async forDevice(deviceId: string): Promise<SharedSession[]> {
    return Object.values((await this.read()).sessions).filter(session => session.deviceId === deviceId);
  }

  /** Forgets a session for every holder, once it has ended. */
  async drop(key: string): Promise<void> {
    await this.update(state => { delete state.sessions[key]; });
  }

  async hold(session: Omit<SharedSession, 'holders'>, sessionId: string): Promise<void> {
    await this.update(state => {
      const entry = state.sessions[session.key] ??= { ...session, holders: [] };
      entry.holders = entry.holders.filter(holder => !(holder.pid === this.pid && holder.sessionId === sessionId));
      entry.holders.push({ pid: this.pid, sessionId, since: new Date().toISOString() });
    });
  }

  /** Drops this server's hold. The session should end only when it was the last holder of a Device Hub session. */
  async release(key: string, sessionId: string): Promise<{ last: boolean; foreign: boolean }> {
    return this.update(state => {
      const entry = state.sessions[key];
      if (!entry) return { last: true, foreign: false };
      entry.holders = entry.holders.filter(holder => !(holder.pid === this.pid && holder.sessionId === sessionId));
      if (!entry.holders.length) delete state.sessions[key];
      return { last: !entry.holders.length, foreign: Boolean(entry.foreign) };
    });
  }

  /** Sessions other Device Hub servers hold, such as another chat or window. */
  async elsewhere(): Promise<SharedSession[]> {
    return Object.values((await this.read()).sessions)
      .map(session => ({ ...session, holders: session.holders.filter(holder => holder.pid !== this.pid) }))
      .filter(session => session.holders.length);
  }

  async setFocus(deviceId: string, deviceName: string): Promise<void> {
    await this.update(state => { state.focus = { deviceId, deviceName, pid: this.pid, at: new Date().toISOString() }; });
  }

  async focus(): Promise<RegistryFocus | undefined> {
    return (await this.read()).focus;
  }

  async clearFocus(deviceId: string): Promise<void> {
    await this.update(state => { if (state.focus?.deviceId === deviceId) delete state.focus; });
  }

  async markCreated(deviceId: string): Promise<void> {
    await this.update(state => { if (!state.created.includes(deviceId)) state.created.push(deviceId); });
  }

  async createdDevices(): Promise<string[]> {
    return (await this.read()).created;
  }

  async forgetCreated(deviceId: string): Promise<void> {
    await this.update(state => { state.created = state.created.filter(id => id !== deviceId); });
  }
}
