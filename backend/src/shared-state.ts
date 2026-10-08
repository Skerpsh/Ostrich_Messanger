import crypto from "node:crypto";
import type { Redis } from "ioredis";

// What the backend's processes share: events for the websockets, who is
// connected, websocket tickets and failed logins. One process keeps it in
// memory (the default); several processes, on one server or more, share
// it through Redis (REDIS_URL), each with its own sockets.

// An event for websockets, delivered by every process to its own sockets.
export type ClusterEvent =
  // `data` to all sockets of these users.
  | { type: "deliver"; userIds: string[]; data: string }
  // Close the sockets of a session, or of a user (except one session).
  | { type: "close"; tokenHash?: string; userId?: string; keepTokenHash?: string };

export interface SharedState {
  // This process.
  readonly instanceId: string;

  publish(event: ClusterEvent): Promise<void>;
  // Events from all processes (this one included).
  subscribe(handler: (event: ClusterEvent) => void): void;

  // A socket of the user's session opened / closed on this process;
  // returns how many the user has now on all processes.
  addSocket(userId: string, tokenHash: string): Promise<number>;
  removeSocket(userId: string, tokenHash: string): Promise<number>;
  // How many sockets these users have (missing: none).
  socketCounts(userIds: string[]): Promise<Map<string, number>>;
  // The sessions of these that have a socket open somewhere.
  sessionsWithSockets(tokenHashes: string[]): Promise<Set<string>>;

  // A user's last socket closed: they count as online a little longer,
  // so quick reconnects do not flicker. takeLeaving() ends that and tells
  // whether it was still on.
  setLeaving(userId: string, ms: number): Promise<void>;
  takeLeaving(userId: string): Promise<boolean>;
  leavingUsers(userIds: string[]): Promise<Set<string>>;

  // Single-use websocket tickets.
  putTicket(ticket: string, tokenHash: string, ms: number): Promise<void>;
  takeTicket(ticket: string): Promise<string | null>;

  // Failed logins per key, counted for a window from the first one.
  failures(key: string): Promise<number>;
  addFailure(key: string, windowMs: number): Promise<void>;
  clearFailures(key: string): Promise<void>;

  // On shutdown: this process's sockets are gone.
  close(): Promise<void>;
}

// --- in memory (one process) ---

export class MemoryState implements SharedState {
  readonly instanceId = crypto.randomUUID();

  private handlers: ((event: ClusterEvent) => void)[] = [];
  private userSockets = new Map<string, number>();
  private sessionSockets = new Map<string, number>();
  private leaving = new Map<string, number>();
  private tickets = new Map<string, { tokenHash: string; expiresAt: number }>();
  private failed = new Map<string, { count: number; resetAt: number }>();

  async publish(event: ClusterEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  subscribe(handler: (event: ClusterEvent) => void) {
    this.handlers.push(handler);
  }

  private static change(map: Map<string, number>, key: string, by: number) {
    const count = Math.max((map.get(key) ?? 0) + by, 0);

    if (count === 0) {
      map.delete(key);
    } else {
      map.set(key, count);
    }

    return count;
  }

  async addSocket(userId: string, tokenHash: string) {
    MemoryState.change(this.sessionSockets, tokenHash, 1);
    return MemoryState.change(this.userSockets, userId, 1);
  }

  async removeSocket(userId: string, tokenHash: string) {
    MemoryState.change(this.sessionSockets, tokenHash, -1);
    return MemoryState.change(this.userSockets, userId, -1);
  }

  async socketCounts(userIds: string[]) {
    return new Map(userIds.map((id) => [id, this.userSockets.get(id) ?? 0]));
  }

  async sessionsWithSockets(tokenHashes: string[]) {
    return new Set(tokenHashes.filter((hash) => this.sessionSockets.has(hash)));
  }

  async setLeaving(userId: string, ms: number) {
    this.leaving.set(userId, Date.now() + ms);
  }

  async takeLeaving(userId: string) {
    const until = this.leaving.get(userId);
    this.leaving.delete(userId);

    return until !== undefined && until > Date.now();
  }

  async leavingUsers(userIds: string[]) {
    const now = Date.now();
    return new Set(userIds.filter((id) => (this.leaving.get(id) ?? 0) > now));
  }

  async putTicket(ticket: string, tokenHash: string, ms: number) {
    const now = Date.now();

    for (const [other, entry] of this.tickets) {
      if (entry.expiresAt <= now) {
        this.tickets.delete(other);
      }
    }

    this.tickets.set(ticket, { tokenHash, expiresAt: now + ms });
  }

  async takeTicket(ticket: string) {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);

    return entry && entry.expiresAt > Date.now() ? entry.tokenHash : null;
  }

  async failures(key: string) {
    const entry = this.failed.get(key);

    if (!entry || entry.resetAt <= Date.now()) {
      this.failed.delete(key);
      return 0;
    }

    return entry.count;
  }

  async addFailure(key: string, windowMs: number) {
    const now = Date.now();
    const entry = this.failed.get(key);

    if (entry && entry.resetAt > now) {
      entry.count++;
      return;
    }

    // Drop stale entries so the map cannot grow without bound.
    if (this.failed.size >= 10_000) {
      for (const [other, stale] of this.failed) {
        if (stale.resetAt <= now) {
          this.failed.delete(other);
        }
      }
    }

    this.failed.set(key, { count: 1, resetAt: now + windowMs });
  }

  async clearFailures(key: string) {
    this.failed.delete(key);
  }

  async close() {}
}

// --- Redis (several processes) ---

const PREFIX = "ostrich:";
const CHANNEL = `${PREFIX}events`;

// A process counts as running while its key exists; it is renewed
// every INSTANCE_RENEW_MS. Sockets of a process that died (no clean
// shutdown) stop counting once its key expires.
const INSTANCE_TTL_MS = 30_000;
const INSTANCE_RENEW_MS = 10_000;

const instanceKey = (id: string) => `${PREFIX}instance:${id}`;
const userSocketsKey = (userId: string) => `${PREFIX}sockets:user:${userId}`;
const sessionSocketsKey = (tokenHash: string) => `${PREFIX}sockets:session:${tokenHash}`;
const leavingKey = (userId: string) => `${PREFIX}leaving:${userId}`;
const ticketKey = (ticket: string) => `${PREFIX}ticket:${ticket}`;
const failedKey = (key: string) => `${PREFIX}failed-login:${key}`;

// Socket counts are kept per process in a hash (field: process id), so a
// dead process's sockets can be left out.
export class RedisState implements SharedState {
  readonly instanceId = crypto.randomUUID();

  private handlers: ((event: ClusterEvent) => void)[] = [];
  private renew: NodeJS.Timeout;
  // What this process has counted, to take back on shutdown.
  private ownUsers = new Set<string>();
  private ownSessions = new Set<string>();

  constructor(
    // Commands.
    private redis: Redis,
    // Pub/sub needs a connection of its own.
    private subscriber: Redis,
    private onError: (error: unknown) => void = () => {},
  ) {
    this.subscriber.on("message", (channel: string, message: string) => {
      if (channel !== CHANNEL) {
        return;
      }

      try {
        const event = JSON.parse(message) as ClusterEvent;

        for (const handler of this.handlers) {
          handler(event);
        }
      } catch (error) {
        this.onError(error);
      }
    });

    const alive = () =>
      this.redis.set(instanceKey(this.instanceId), "1", "PX", INSTANCE_TTL_MS).catch(this.onError);

    alive();
    this.renew = setInterval(alive, INSTANCE_RENEW_MS);
    this.renew.unref();
  }

  // Subscribes before taking events: none are missed after start().
  async start() {
    await this.redis.set(instanceKey(this.instanceId), "1", "PX", INSTANCE_TTL_MS);
    await this.subscriber.subscribe(CHANNEL);
  }

  async publish(event: ClusterEvent) {
    await this.redis.publish(CHANNEL, JSON.stringify(event));
  }

  subscribe(handler: (event: ClusterEvent) => void) {
    this.handlers.push(handler);
  }

  // The processes of these ids that are running.
  private async running(ids: string[]) {
    const unique = [...new Set(ids)];

    if (unique.length === 0) {
      return new Set<string>();
    }

    const values = await this.redis.mget(...unique.map(instanceKey));

    return new Set(unique.filter((_, i) => values[i] !== null));
  }

  // Sums per-process counts, leaving out (and removing) dead processes'.
  private async totals(keys: string[], counts: Record<string, string>[]) {
    const alive = await this.running(counts.flatMap((hash) => Object.keys(hash)));
    const dead: [string, string][] = [];

    const totals = counts.map((hash, i) => {
      let total = 0;

      for (const [instance, count] of Object.entries(hash)) {
        if (alive.has(instance)) {
          total += Number(count);
        } else {
          dead.push([keys[i], instance]);
        }
      }

      return total;
    });

    if (dead.length > 0) {
      const cleanup = this.redis.multi();

      for (const [key, instance] of dead) {
        cleanup.hdel(key, instance);
      }

      await cleanup.exec();
    }

    return totals;
  }

  // Changes this process's count and returns the user's total, in one
  // transaction: of sockets opened at the same moment on two processes,
  // exactly one sees itself as the first.
  private async changeSocket(userId: string, tokenHash: string, by: number) {
    const userKey = userSocketsKey(userId);
    const sessionKey = sessionSocketsKey(tokenHash);

    const results = await this.redis
      .multi()
      .hincrby(userKey, this.instanceId, by)
      .hincrby(sessionKey, this.instanceId, by)
      .hgetall(userKey)
      .exec();

    if (!results) {
      throw new Error("Redis transaction failed");
    }

    for (const [error] of results) {
      if (error) {
        throw error;
      }
    }

    const own = Number(results[0][1]);
    const ownSession = Number(results[1][1]);

    // Nothing left here: the fields go (also ends negative counts).
    if (own <= 0 || ownSession <= 0) {
      const cleanup = this.redis.multi();

      if (own <= 0) {
        cleanup.hdel(userKey, this.instanceId);
        this.ownUsers.delete(userId);
      }

      if (ownSession <= 0) {
        cleanup.hdel(sessionKey, this.instanceId);
        this.ownSessions.delete(tokenHash);
      }

      await cleanup.exec();
    }

    if (own > 0) {
      this.ownUsers.add(userId);
    }

    if (ownSession > 0) {
      this.ownSessions.add(tokenHash);
    }

    const hash = { ...(results[2][1] as Record<string, string>) };

    if (own <= 0) {
      delete hash[this.instanceId];
    }

    const [total] = await this.totals([userKey], [hash]);

    return total;
  }

  addSocket(userId: string, tokenHash: string) {
    return this.changeSocket(userId, tokenHash, 1);
  }

  removeSocket(userId: string, tokenHash: string) {
    return this.changeSocket(userId, tokenHash, -1);
  }

  private async hashes(keys: string[]) {
    if (keys.length === 0) {
      return [];
    }

    const pipeline = this.redis.pipeline();

    for (const key of keys) {
      pipeline.hgetall(key);
    }

    const results = (await pipeline.exec()) ?? [];

    return results.map(([error, value]) => {
      if (error) {
        throw error;
      }

      return (value ?? {}) as Record<string, string>;
    });
  }

  async socketCounts(userIds: string[]) {
    const keys = userIds.map(userSocketsKey);
    const totals = await this.totals(keys, await this.hashes(keys));

    return new Map(userIds.map((id, i) => [id, totals[i]]));
  }

  async sessionsWithSockets(tokenHashes: string[]) {
    const keys = tokenHashes.map(sessionSocketsKey);
    const totals = await this.totals(keys, await this.hashes(keys));

    return new Set(tokenHashes.filter((_, i) => totals[i] > 0));
  }

  async setLeaving(userId: string, ms: number) {
    await this.redis.set(leavingKey(userId), this.instanceId, "PX", ms);
  }

  async takeLeaving(userId: string) {
    return (await this.redis.del(leavingKey(userId))) > 0;
  }

  async leavingUsers(userIds: string[]) {
    if (userIds.length === 0) {
      return new Set<string>();
    }

    const values = await this.redis.mget(...userIds.map(leavingKey));

    return new Set(userIds.filter((_, i) => values[i] !== null));
  }

  async putTicket(ticket: string, tokenHash: string, ms: number) {
    await this.redis.set(ticketKey(ticket), tokenHash, "PX", ms);
  }

  async takeTicket(ticket: string) {
    const results = await this.redis.multi().get(ticketKey(ticket)).del(ticketKey(ticket)).exec();
    const value = results?.[0]?.[1];

    return typeof value === "string" ? value : null;
  }

  async failures(key: string) {
    return Number((await this.redis.get(failedKey(key))) ?? 0);
  }

  async addFailure(key: string, windowMs: number) {
    const count = await this.redis.incr(failedKey(key));

    // The window starts with the first failure.
    if (count === 1) {
      await this.redis.pexpire(failedKey(key), windowMs);
    }
  }

  async clearFailures(key: string) {
    await this.redis.del(failedKey(key));
  }

  async close() {
    clearInterval(this.renew);

    const cleanup = this.redis.multi();

    for (const userId of this.ownUsers) {
      cleanup.hdel(userSocketsKey(userId), this.instanceId);
    }

    for (const tokenHash of this.ownSessions) {
      cleanup.hdel(sessionSocketsKey(tokenHash), this.instanceId);
    }

    cleanup.del(instanceKey(this.instanceId));
    await cleanup.exec();

    this.subscriber.disconnect();
    this.redis.disconnect();
  }
}

// --- the process's state ---

let state: SharedState = new MemoryState();
let redisClient: Redis | null = null;

export function sharedState() {
  return state;
}

// The Redis connection for other users of it (rate limits); null without.
export function sharedRedis() {
  return redisClient;
}

// Connects to Redis if REDIS_URL is set; call once before serving.
export async function setUpSharedState(
  url: string | undefined,
  onError: (error: unknown) => void,
) {
  if (!url) {
    return;
  }

  const { Redis } = await import("ioredis");
  const options = { maxRetriesPerRequest: 3, lazyConnect: false };
  const redis = new Redis(url, options);
  const subscriber = new Redis(url, options);

  redis.on("error", onError);
  subscriber.on("error", onError);

  const redisState = new RedisState(redis, subscriber, onError);
  await redisState.start();

  state = redisState;
  redisClient = redis;
}

// For tests.
export function useSharedState(next: SharedState) {
  state = next;
}
