import assert from "node:assert/strict";
import test from "node:test";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { MemoryState, RedisState, type ClusterEvent, type SharedState } from "../src/shared-state.js";

// The same behaviour in memory and through Redis (ioredis-mock: clients
// share one database, like processes sharing a Redis server).

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function redisProcess() {
  const state = new RedisState(new RedisMock() as unknown as Redis, new RedisMock() as unknown as Redis);
  await state.start();

  return state;
}

function behaves(name: string, make: () => Promise<SharedState>, makeOther: (first: SharedState) => Promise<SharedState>) {
  test(`${name}: sockets and presence`, async () => {
    const a = await make();
    const b = await makeOther(a);

    assert.equal(await a.addSocket("u1", "s1"), 1);
    assert.equal(await b.addSocket("u1", "s2"), 2);
    assert.deepEqual([...(await a.socketCounts(["u1", "u2"]))], [["u1", 2], ["u2", 0]]);
    assert.deepEqual([...(await b.sessionsWithSockets(["s1", "s2", "s3"]))], ["s1", "s2"]);

    assert.equal(await a.removeSocket("u1", "s1"), 1);
    assert.equal(await b.removeSocket("u1", "s2"), 0);
    assert.deepEqual([...(await a.sessionsWithSockets(["s1", "s2"]))], []);

    await a.setLeaving("u1", 1000);
    assert.deepEqual([...(await b.leavingUsers(["u1", "u2"]))], ["u1"]);
    assert.equal(await b.takeLeaving("u1"), true);
    assert.equal(await a.takeLeaving("u1"), false);

    await a.close();
    await b.close();
  });

  test(`${name}: events reach every process`, async () => {
    const a = await make();
    const b = await makeOther(a);
    const got: [string, ClusterEvent][] = [];

    a.subscribe((event) => got.push(["a", event]));
    b.subscribe((event) => got.push(["b", event]));

    await a.publish({ type: "deliver", userIds: ["u1"], data: "{}" });
    await wait(20);

    // Both subscribers get it (in memory both are the one process).
    assert.deepEqual(got.map(([who]) => who).sort(), ["a", "b"]);
    assert.deepEqual(got[0][1], { type: "deliver", userIds: ["u1"], data: "{}" });

    await a.close();
    await b.close();
  });

  test(`${name}: tickets are single-use and expire`, async () => {
    const a = await make();
    const b = await makeOther(a);

    await a.putTicket("t1", "hash", 1000);
    assert.equal(await b.takeTicket("t1"), "hash");
    assert.equal(await a.takeTicket("t1"), null);

    await a.putTicket("t2", "hash", 10);
    await wait(30);
    assert.equal(await b.takeTicket("t2"), null);

    await a.close();
    await b.close();
  });

  test(`${name}: failed logins`, async () => {
    const a = await make();
    const b = await makeOther(a);

    await a.addFailure("bob 1.2.3.4", 1000);
    await b.addFailure("bob 1.2.3.4", 1000);
    assert.equal(await a.failures("bob 1.2.3.4"), 2);
    assert.equal(await a.failures("bob 5.6.7.8"), 0);

    await b.clearFailures("bob 1.2.3.4");
    assert.equal(await a.failures("bob 1.2.3.4"), 0);

    await a.addFailure("ann 1.2.3.4", 10);
    await wait(30);
    assert.equal(await b.failures("ann 1.2.3.4"), 0);

    await a.close();
    await b.close();
  });
}

behaves("memory", async () => new MemoryState(), async (first) => first);
behaves("redis", redisProcess, () => redisProcess());

test("redis: a process that died stops counting", async () => {
  const a = await redisProcess();
  const b = await redisProcess();
  const redis = new RedisMock() as unknown as Redis;

  await a.addSocket("u1", "s1");
  await b.addSocket("u1", "s2");

  // a's key expires without a clean shutdown.
  await redis.del(`ostrich:instance:${a.instanceId}`);

  assert.deepEqual([...(await b.socketCounts(["u1"]))], [["u1", 1]]);
  assert.deepEqual([...(await b.sessionsWithSockets(["s1", "s2"]))], ["s2"]);
  // Its fields are gone too.
  assert.deepEqual(Object.keys(await redis.hgetall("ostrich:sockets:user:u1")), [b.instanceId]);

  await b.close();
});

test("redis: of two first sockets at once, one is first", async () => {
  const a = await redisProcess();
  const b = await redisProcess();

  const totals = await Promise.all([a.addSocket("u9", "s1"), b.addSocket("u9", "s2")]);
  assert.deepEqual(totals.sort(), [1, 2]);

  await a.close();
  await b.close();
});
