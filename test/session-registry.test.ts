import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRegistry } from "../src/session-registry.js";

const crashedPid = 999_999;

test("the last live holder ends a shared session, crashed holders are pruned, and foreign sessions are never ended", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "device-hub-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mine = new SessionRegistry(directory);
  const other = new SessionRegistry(directory, process.ppid);
  await mine.hold({ key: "K", deviceId: "d", deviceName: "D" }, "s1");
  await other.hold({ key: "K", deviceId: "d", deviceName: "D" }, "s2");
  await new SessionRegistry(directory, crashedPid).hold({ key: "Gone", deviceId: "e", deviceName: "E" }, "s3");
  assert.deepEqual((await mine.elsewhere()).map(session => [session.key, session.holders.map(holder => holder.sessionId)]), [["K", ["s2"]]]);
  assert.equal(await mine.find("Gone"), undefined, "a crashed server's hold does not keep its entry alive");
  assert.deepEqual(await mine.release("K", "s1"), { last: false, foreign: false });
  assert.deepEqual(await other.release("K", "s2"), { last: true, foreign: false });
  assert.equal(await mine.find("K"), undefined);
  await mine.hold({ key: "F", deviceId: "d", deviceName: "D", foreign: true }, "s1");
  assert.deepEqual(await mine.release("F", "s1"), { last: true, foreign: true });
  assert.equal((await stat(join(directory, "sessions.json"))).mode & 0o777, 0o600);
});

test("concurrent servers serialize their updates and share focus and created simulators", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "device-hub-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const servers = Array.from({ length: 8 }, () => new SessionRegistry(directory));
  await Promise.all(servers.map((server, index) => server.hold({ key: "K", deviceId: "d", deviceName: "D" }, `s${index}`)));
  assert.equal((await servers[0]!.find("K"))?.holders.length, 8);
  await servers[0]!.setFocus("d", "D");
  assert.deepEqual([(await servers[1]!.focus())?.deviceId, (await servers[1]!.focus())?.pid], ["d", process.pid]);
  await Promise.all([servers[2]!.markCreated("x"), servers[3]!.markCreated("y")]);
  assert.deepEqual((await servers[4]!.createdDevices()).sort(), ["x", "y"]);
  await servers[5]!.forgetCreated("x");
  assert.deepEqual(await servers[6]!.createdDevices(), ["y"]);
});
