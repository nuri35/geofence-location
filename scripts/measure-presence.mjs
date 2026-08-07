// Measurement harness for ADR 0007 (presence read strategy). Deliberately dependency-free
// beyond what the app already ships (pg, ioredis). Closed-loop load: N workers, each a
// sequential request loop over a keep-alive agent — in-flight concurrency is exactly N.
//
// Usage:
//   node scripts/measure-presence.mjs floors            # harness floor: 404 route + /health
//   node scripts/measure-presence.mjs strategy <label>  # workloads a+b at all concurrency levels
//
// The server must already be running (node dist/main) with PRESENCE_READ_STRATEGY=<label>.

import http from 'node:http';
import { hrtime } from 'node:process';
import { Client } from 'pg';
import Redis from 'ioredis';
import { config } from 'dotenv';

config();

const BASE_HOST = '127.0.0.1';
const BASE_PORT = parseInt(process.env.PORT ?? '3000', 10);
const CONCURRENCIES = [10, 50, 200, 500];
const RUN_MS = 12_000;
const WARMUP_MS = 2_000;
const USERS = 10_000; // matches ADR 0004's load assumption; large enough that advisory-lock collisions are rare at 500 in flight
const AREA = { lngMin: 10, latMin: 10, lngMax: 20, latMax: 20 };

const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });

const pgClient = new Client({
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT, 10),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT, 10),
  lazyConnect: true,
  enableOfflineQueue: false,
});

const rand = (n) => Math.floor(Math.random() * n);
const insidePoint = () => ({ lng: 13 + Math.random() * 4, lat: 13 + Math.random() * 4 });
const outsidePoint = () => ({ lng: 58 + Math.random() * 4, lat: 58 + Math.random() * 4 });

const request = (method, path, body) =>
  new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: BASE_HOST,
        port: BASE_PORT,
        method,
        path,
        agent,
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.resume(); // drain
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', () => resolve(0)); // network error
    if (payload !== undefined) req.write(payload);
    req.end();
  });

const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

/** Closed-loop run: `concurrency` workers loop makeRequest() for RUN_MS; first WARMUP_MS discarded. */
async function runLoad(concurrency, makeRequest, okStatus) {
  const latencies = [];
  const errors = new Map();
  let count = 0;
  const start = Date.now();
  const warmupEnd = start + WARMUP_MS;
  const end = start + RUN_MS;

  const worker = async () => {
    while (Date.now() < end) {
      const t0 = hrtime.bigint();
      const status = await makeRequest();
      const ms = Number(hrtime.bigint() - t0) / 1e6;
      if (Date.now() > warmupEnd) {
        count += 1;
        if (status === okStatus) {
          latencies.push(ms);
        } else {
          errors.set(status, (errors.get(status) ?? 0) + 1);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  const measuredSeconds = (RUN_MS - WARMUP_MS) / 1000;
  return {
    concurrency,
    requests: count,
    throughput: +(count / measuredSeconds).toFixed(0),
    p50: +percentile(latencies, 50)?.toFixed(1),
    p95: +percentile(latencies, 95)?.toFixed(1),
    p99: +percentile(latencies, 99)?.toFixed(1),
    mean: +(latencies.reduce((s, v) => s + v, 0) / latencies.length).toFixed(1),
    errors: Object.fromEntries(errors),
  };
}

/** Samples pg_stat_activity every 200 ms while `promise` runs; approximates pool usage and txn ages. */
async function withPgSampling(promise) {
  const samples = [];
  const timer = setInterval(() => {
    pgClient
      .query(
        `SELECT count(*) FILTER (WHERE state = 'active') AS active,
                count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn,
                count(*) AS total,
                count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waiters,
                count(*) FILTER (WHERE wait_event_type = 'Client') AS client_waiters,
                coalesce(max(extract(epoch FROM now() - xact_start)) FILTER (WHERE xact_start IS NOT NULL), 0) AS max_xact_s,
                coalesce(avg(extract(epoch FROM now() - xact_start)) FILTER (WHERE xact_start IS NOT NULL), 0) AS avg_xact_s
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid() AND application_name <> 'psql'`,
        [process.env.POSTGRES_DB],
      )
      .then((r) => samples.push(r.rows[0]))
      .catch(() => {});
  }, 200);
  const result = await promise;
  clearInterval(timer);
  const num = (k) => samples.map((s) => Number(s[k]));
  const max = (k) => (samples.length ? Math.max(...num(k)) : 0);
  const avg = (k) => (samples.length ? +(num(k).reduce((a, b) => a + b, 0) / samples.length).toFixed(2) : 0);
  return {
    ...result,
    pool: {
      samples: samples.length,
      maxConnections: max('total'),
      avgActive: avg('active'),
      avgIdleInTxn: avg('idle_in_txn'),
      maxLockWaiters: max('lock_waiters'),
      avgXactMs: +(avg('avg_xact_s') * 1000).toFixed(1),
      maxXactMs: +(max('max_xact_s') * 1000).toFixed(1),
    },
  };
}

async function redisStats() {
  const parse = (info) =>
    Object.fromEntries(
      info
        .split('\r\n')
        .filter((line) => line.includes(':') && !line.startsWith('#'))
        .map((line) => line.split(':')),
    );
  const stats = parse(await redis.info('stats'));
  const commandstats = await redis.info('commandstats');
  const cmd = {};
  for (const line of commandstats.split('\r\n')) {
    const match = line.match(/^cmdstat_(get|set|del):calls=(\d+),usec=(\d+)/);
    if (match) cmd[match[1]] = { calls: +match[2], usec: +match[3] };
  }
  return {
    hits: +stats.keyspace_hits,
    misses: +stats.keyspace_misses,
    cmd,
  };
}

const diffRedis = (before, after) => {
  const hits = after.hits - before.hits;
  const misses = after.misses - before.misses;
  const cmdDelta = {};
  for (const name of ['get', 'set', 'del']) {
    const calls = (after.cmd[name]?.calls ?? 0) - (before.cmd[name]?.calls ?? 0);
    const usec = (after.cmd[name]?.usec ?? 0) - (before.cmd[name]?.usec ?? 0);
    if (calls > 0) cmdDelta[name] = { calls, usecPerCall: +(usec / calls).toFixed(1) };
  }
  return { hitRate: hits + misses > 0 ? +(hits / (hits + misses)).toFixed(3) : null, cmd: cmdDelta };
};

async function setupState() {
  await pgClient.query('TRUNCATE user_area_presence, logs');
  const existing = await pgClient.query("SELECT id FROM areas WHERE name = 'load-area'");
  if (existing.rows.length === 0) {
    await pgClient.query(
      `INSERT INTO areas (name, boundary) VALUES ('load-area',
         ST_GeomFromText('POLYGON((${AREA.lngMin} ${AREA.latMin}, ${AREA.lngMax} ${AREA.latMin},
                                   ${AREA.lngMax} ${AREA.latMax}, ${AREA.lngMin} ${AREA.latMax},
                                   ${AREA.lngMin} ${AREA.latMin}))', 4326))`,
    );
  }
  await redis.flushdb().catch(() => {});
}

async function warmAllUsersInside() {
  let next = 0;
  const worker = async () => {
    while (next < USERS) {
      const uid = next++;
      await request('POST', '/locations', { userId: `load-${uid}`, ...insidePoint() });
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 100 }, worker));
  console.error(`# warm: ${USERS} users inside in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const workloads = {
  // (a) steady state: every user already inside, every request a no-change ping
  static: () => request('POST', '/locations', { userId: `load-${rand(USERS)}`, ...insidePoint() }),
  // (b) transition-heavy: 50% inside / 50% outside — ~half the requests flip state
  transition: () =>
    request('POST', '/locations', {
      userId: `load-${rand(USERS)}`,
      ...(Math.random() < 0.5 ? insidePoint() : outsidePoint()),
    }),
};

async function main() {
  const [mode, label] = process.argv.slice(2);
  await pgClient.connect();
  await redis.connect().catch(() => {});

  if (mode === 'floors') {
    for (const [name, fn, ok] of [
      ['floor-404 (pure Node, no DB)', () => request('GET', '/definitely-not-a-route'), 404],
      ['floor-health (1 DB ping + 1 Redis ping)', () => request('GET', '/health'), 200],
    ]) {
      for (const c of CONCURRENCIES) {
        const r = await runLoad(c, fn, ok);
        console.log(JSON.stringify({ suite: name, ...r }));
      }
    }
  } else if (mode === 'strategy') {
    await setupState();
    await warmAllUsersInside();
    for (const [workload, fn] of Object.entries(workloads)) {
      if (workload === 'transition') await warmAllUsersInside(); // reset: everyone inside again
      for (const c of CONCURRENCIES) {
        const redisBefore = await redisStats().catch(() => null);
        const r = await withPgSampling(runLoad(c, fn, 201));
        const redisAfter = redisBefore && (await redisStats().catch(() => null));
        const redisDelta = redisBefore && redisAfter ? diffRedis(redisBefore, redisAfter) : null;
        console.log(JSON.stringify({ strategy: label, workload, ...r, redis: redisDelta }));
      }
    }
  } else {
    console.error('usage: measure-presence.mjs floors | strategy <label>');
    process.exitCode = 1;
  }

  await pgClient.end();
  redis.disconnect();
  agent.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
