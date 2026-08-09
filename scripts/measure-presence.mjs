// The load harness, rewritten for the async pipeline (N4+). The filename is
// historical — it began life measuring presence-read strategies (ADR 0007) and
// the docs reference it by this name.
//
// What it measures now:
//   - API ingest throughput: closed-loop POST /locations expecting 202. This is
//     the API ALONE — a 202 means "durably queued", not "processed". Never quote
//     it as system throughput.
//   - End-to-end latency: 202 received -> the transition's effect visible in
//     Postgres (entry: log row appears; exit: presence row gone), via tracer
//     users whose every event provably transitions.
//   - Queue depth & drain: sampled every 500 ms via AMQP passive checkQueue —
//     REAL-TIME broker counts, deliberately not the management API, whose stats
//     lag 5–7 s (measured, ADR 0014). Reports max depth, growth rate under
//     load, and time-to-drain after load stops.
//   - Postgres pool behaviour (pg_stat_activity sampling), as before.
//
// LIMITS — read before quoting numbers (a number with an unstated condition has
// misled this project twice):
//   - End-to-end latency is measurable ONLY for transition events. The ~99%
//     no-change fast path completes without any externally observable effect
//     (that is its point); its latency cannot be measured from outside the
//     worker and is NOT in these numbers.
//   - Tracer latency resolution is the poll interval (25 ms) plus Postgres
//     visibility; tracers also cost ~hundreds of tiny PK reads/s — an observer
//     effect on the same database under test.
//   - Ingest throughput and e2e latency interact through the shared box: the
//     closed-loop load, the worker, Postgres, and this script all compete for
//     the same CPU. Single-window comparisons on this machine drift ±15–20%
//     (N2/N3); use ABBA bracketing per .claude/skills/testing-verification.
//   - Worker-internal fast-path rate, dedup hits, and presence-memory behaviour
//     are not externally observable; this harness cannot report them.
//   - If no consumer is attached, e2e/drain metrics are skipped with a warning:
//     depth then only ever grows and "drain" is meaningless.
//
// Prerequisites are ENFORCED where cheap (see the measurement checklist in
// .claude/skills/testing-verification): the fixture area must exist BEFORE the
// measured server booted (its boot snapshot must contain it — this script
// checks the area exists and refuses if not); partitions are purged before each
// workload; the post-warm backlog is drained before measurement starts.
//
// Usage:
//   node scripts/measure-presence.mjs floors                 # 404 + /health ceilings
//   node scripts/measure-presence.mjs measure <label> [--seconds N]
//
// The server (node dist/main) and the worker (node dist/worker-main) must
// already be running. <label> tags output rows (use ABBA labels: A1/B1/B2/A2).

import http from 'node:http';
import { hrtime } from 'node:process';
import amqp from 'amqplib';
import pg from 'pg';
import { config } from 'dotenv';

config();

const BASE_HOST = '127.0.0.1';
const BASE_PORT = parseInt(process.env.PORT ?? '3000', 10);
// --quick: one concurrency, for proving the instrument works — not for quoting.
const CONCURRENCIES = process.argv.includes('--quick') ? [50] : [10, 50, 200, 500];
const secondsArg = process.argv.indexOf('--seconds');
const RUN_MS = (secondsArg > -1 ? parseInt(process.argv[secondsArg + 1], 10) : 12) * 1000;
const WARMUP_MS = Math.min(2_000, RUN_MS / 4);
const USERS = 10_000;
const TRACERS = 8;
const TRACER_POLL_MS = 25;
const DEPTH_SAMPLE_MS = 500;
const PARTITIONS = parseInt(process.env.MQ_PARTITION_COUNT ?? '8', 10);
// The fixture polygon is (10 10, 20 10, 20 20, 10 20) — created by the OPERATOR
// before the measured processes boot (see ensurePrerequisites), not by this script.

const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });

const pgClient = new pg.Pool({
  max: 10, // tracers + samplers run concurrently; a single Client queues (deprecated in pg@9)
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT, 10),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const rand = (n) => Math.floor(Math.random() * n);
const insidePoint = () => ({ lng: 13 + Math.random() * 4, lat: 13 + Math.random() * 4 });
const outsidePoint = () => ({ lng: 58 + Math.random() * 4, lat: 58 + Math.random() * 4 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', () => resolve(0));
    if (payload !== undefined) req.write(payload);
    req.end();
  });

const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: +percentile(sorted, 50).toFixed(1),
    p95: +percentile(sorted, 95).toFixed(1),
    p99: +percentile(sorted, 99).toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
  };
};

// ---------------------------------------------------------------------------
// Queue plane — AMQP passive ops only (real-time counts; the mgmt API lags 5–7 s)
// ---------------------------------------------------------------------------
let amqpConnection = null;
let amqpChannel = null;

const queueName = (i) => `loc.events.p${i}`;

const connectAmqp = async () => {
  amqpConnection = await amqp.connect(
    `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}@${process.env.RABBITMQ_HOST ?? 'localhost'}:${process.env.RABBITMQ_PORT ?? '5672'}`,
  );
  amqpChannel = await amqpConnection.createChannel();
  // checkQueue is passive: this harness, like the app, never declares topology.
  amqpChannel.on('error', () => {});
};

const queueTotals = async () => {
  let messages = 0;
  let consumers = 0;
  for (let i = 0; i < PARTITIONS; i += 1) {
    const q = await amqpChannel.checkQueue(queueName(i));
    messages += q.messageCount;
    consumers += q.consumerCount;
  }
  return { messages, consumers };
};

const purgeAllPartitions = async () => {
  for (let i = 0; i < PARTITIONS; i += 1) {
    await amqpChannel.purgeQueue(queueName(i));
  }
};

const waitForDrain = async (timeoutMs) => {
  const started = Date.now();
  for (;;) {
    const { messages } = await queueTotals();
    if (messages === 0) return Date.now() - started;
    if (Date.now() - started > timeoutMs) return -1; // did not drain
    await sleep(200);
  }
};

// ---------------------------------------------------------------------------
// Tracers — end-to-end latency on events that provably transition
// ---------------------------------------------------------------------------
const tracerLoop = async (tracerId, deadline, out) => {
  const userId = `trace-${tracerId}`;
  let inside = false;
  // Start from a known state: one exit event, then wait for presence to be empty.
  await request('POST', '/locations', { userId, ...outsidePoint() });
  await pollUntil(async () => (await presenceCount(userId)) === 0, 10_000);
  while (Date.now() < deadline) {
    if (!inside) {
      const before = await logCount(userId);
      const status = await request('POST', '/locations', { userId, ...insidePoint() });
      if (status !== 202) {
        out.errors += 1;
        continue;
      }
      const t0 = hrtime.bigint();
      const seen = await pollUntil(async () => (await logCount(userId)) > before, 15_000);
      if (seen) out.entryMs.push(Number(hrtime.bigint() - t0) / 1e6);
      else out.timeouts += 1;
      inside = true;
    } else {
      const status = await request('POST', '/locations', { userId, ...outsidePoint() });
      if (status !== 202) {
        out.errors += 1;
        continue;
      }
      const t0 = hrtime.bigint();
      const gone = await pollUntil(async () => (await presenceCount(userId)) === 0, 15_000);
      if (gone) out.exitMs.push(Number(hrtime.bigint() - t0) / 1e6);
      else out.timeouts += 1;
      inside = false;
    }
  }
};

const pollUntil = async (condition, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(TRACER_POLL_MS);
  }
  return false;
};

const logCount = async (userId) => {
  const r = await pgClient.query('SELECT count(*)::int AS n FROM logs WHERE user_id = $1', [
    userId,
  ]);
  return r.rows[0].n;
};

const presenceCount = async (userId) => {
  const r = await pgClient.query(
    'SELECT count(*)::int AS n FROM user_area_presence WHERE user_id = $1',
    [userId],
  );
  return r.rows[0].n;
};

// ---------------------------------------------------------------------------
// Load + samplers (closed loop as before; ok status is now 202)
// ---------------------------------------------------------------------------
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
        if (status === okStatus) latencies.push(ms);
        else errors.set(status, (errors.get(status) ?? 0) + 1);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  latencies.sort((a, b) => a - b);
  const measuredSeconds = (RUN_MS - WARMUP_MS) / 1000;
  return {
    concurrency,
    requests: count,
    // API-ONLY number: a 202 means "queued", not "processed".
    ingestThroughput: +(count / measuredSeconds).toFixed(0),
    requestLatency: stats(latencies),
    errors: Object.fromEntries(errors),
  };
}

async function withPgSampling(promise) {
  const samples = [];
  const timer = setInterval(() => {
    pgClient
      .query(
        `SELECT count(*) FILTER (WHERE state = 'active') AS active,
                count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn,
                count(*) AS total,
                coalesce(max(extract(epoch FROM now() - xact_start)) FILTER (WHERE xact_start IS NOT NULL), 0) AS max_xact_s
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [process.env.POSTGRES_DB],
      )
      .then((r) => samples.push(r.rows[0]))
      .catch(() => {});
  }, 200);
  const result = await promise;
  clearInterval(timer);
  const num = (k) => samples.map((s) => Number(s[k]));
  const max = (k) => (samples.length ? Math.max(...num(k)) : 0);
  const avg = (k) =>
    samples.length ? +(num(k).reduce((a, b) => a + b, 0) / samples.length).toFixed(2) : 0;
  return {
    ...result,
    pool: {
      avgActive: avg('active'),
      avgIdleInTxn: avg('idle_in_txn'),
      maxConnections: max('total'),
      maxXactMs: +(max('max_xact_s') * 1000).toFixed(1),
    },
  };
}

const sampleDepthDuring = (promise) => {
  const series = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const { messages } = await queueTotals();
        series.push({ t: Date.now(), messages });
      } catch {
        // sampling must never kill the run
      }
      await sleep(DEPTH_SAMPLE_MS);
    }
  })();
  return promise.then(async (result) => {
    stop = true;
    await loop;
    return { result, series };
  });
};

const depthSummary = (series, runStart, runEnd) => {
  if (series.length < 2) return null;
  const inRun = series.filter((s) => s.t >= runStart && s.t <= runEnd);
  const depths = inRun.map((s) => s.messages);
  const first = inRun[0];
  const last = inRun[inRun.length - 1];
  const growthPerSec =
    last && first && last.t > first.t
      ? +(((last.messages - first.messages) / (last.t - first.t)) * 1000).toFixed(1)
      : 0;
  return {
    max: depths.length ? Math.max(...depths) : 0,
    atLoadEnd: last?.messages ?? 0,
    growthPerSec, // >0: workers falling behind while load runs; <=0: keeping up
  };
};

// ---------------------------------------------------------------------------
// Setup / prerequisites (enforced, not just documented)
// ---------------------------------------------------------------------------
async function ensurePrerequisites() {
  const area = await pgClient.query("SELECT id FROM areas WHERE name = 'load-area'");
  if (area.rows.length === 0) {
    console.error(
      'FATAL: load-area does not exist. Create it BEFORE booting the measured server\n' +
        '(the boot snapshot must contain it), then restart server + worker:\n' +
        `  INSERT INTO areas (name, boundary) VALUES ('load-area', ST_GeomFromText('POLYGON((10 10, 20 10, 20 20, 10 20, 10 10))', 4326));\n` +
        '  UPDATE area_version SET version = version + 1;\n' +
        'Checklist: .claude/skills/testing-verification (measurement discipline).',
    );
    process.exit(1);
  }
  const { consumers } = await queueTotals();
  if (consumers === 0) {
    console.error(
      'WARNING: no consumers attached to the partitions — is the worker running?\n' +
        'Ingest throughput will still be measured; e2e latency and drain will be SKIPPED\n' +
        '(depth only grows without a worker).',
    );
  }
  return { workerPresent: consumers > 0 };
}

async function warmAllUsersInside(workerPresent) {
  let next = 0;
  const worker = async () => {
    while (next < USERS) {
      const uid = next++;
      await request('POST', '/locations', { userId: `load-${uid}`, ...insidePoint() });
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 100 }, worker));
  console.error(
    `# warm: ${USERS} users' entry events published in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (workerPresent) {
    const drainMs = await waitForDrain(180_000);
    console.error(
      drainMs >= 0
        ? `# warm backlog drained in ${(drainMs / 1000).toFixed(1)}s`
        : '# WARNING: warm backlog did not drain in 180s — measurement will start against a backlog',
    );
  }
}

const workloads = {
  // steady state: every user already inside, every event a no-change ping
  static: () => request('POST', '/locations', { userId: `load-${rand(USERS)}`, ...insidePoint() }),
  // transition-heavy: ~half the events flip membership
  transition: () =>
    request('POST', '/locations', {
      userId: `load-${rand(USERS)}`,
      ...(Math.random() < 0.5 ? insidePoint() : outsidePoint()),
    }),
};

// ---------------------------------------------------------------------------
async function main() {
  const [mode, label] = process.argv.slice(2);

  if (mode === 'floors') {
    for (const [name, fn, ok] of [
      ['floor-404 (pure Node, no broker)', () => request('GET', '/definitely-not-a-route'), 404],
      ['floor-health (1 DB ping)', () => request('GET', '/health'), 200],
    ]) {
      for (const c of CONCURRENCIES) {
        const r = await runLoad(c, fn, ok);
        console.log(JSON.stringify({ suite: name, ...r }));
      }
    }
  } else if (mode === 'measure') {
    await connectAmqp();
    const { workerPresent } = await ensurePrerequisites();
    await pgClient.query('TRUNCATE user_area_presence, logs, user_event_state');
    await purgeAllPartitions();
    await warmAllUsersInside(workerPresent);

    for (const [workload, fn] of Object.entries(workloads)) {
      if (workload === 'transition') await warmAllUsersInside(workerPresent); // reset: everyone inside
      for (const c of CONCURRENCIES) {
        await purgeAllPartitions(); // leftover backlog would pollute depth numbers

        const tracerOut = { entryMs: [], exitMs: [], errors: 0, timeouts: 0 };
        const runStart = Date.now();
        const deadline = runStart + RUN_MS;
        const tracers = workerPresent
          ? Promise.all(
              Array.from({ length: TRACERS }, (_, i) => tracerLoop(i, deadline, tracerOut)),
            )
          : Promise.resolve();

        const { result, series } = await sampleDepthDuring(withPgSampling(runLoad(c, fn, 202)));
        const loadEnd = Date.now();
        await tracers;

        let drainMs = null;
        if (workerPresent) {
          drainMs = await waitForDrain(120_000);
        }

        console.log(
          JSON.stringify({
            label,
            workload,
            ...result,
            queue: {
              ...depthSummary(series, runStart, loadEnd),
              drainAfterLoadMs: drainMs,
            },
            e2e: workerPresent
              ? {
                  entry: stats(tracerOut.entryMs),
                  exit: stats(tracerOut.exitMs),
                  timeouts: tracerOut.timeouts,
                  errors: tracerOut.errors,
                }
              : 'skipped: no worker attached',
          }),
        );
      }
    }
  } else {
    console.error('usage: measure-presence.mjs floors | measure <label> [--seconds N]');
    process.exitCode = 1;
  }

  await pgClient.end();
  await amqpChannel?.close().catch(() => {});
  await amqpConnection?.close().catch(() => {});
  agent.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
