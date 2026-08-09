# .claude/ — how this repo works with Claude Code

For two readers: an engineer joining this repo, and a reviewer assessing how it
was built. Five minutes, then start working.

## What is here and why

| Path | What it is |
| --- | --- |
| `skills/` | The project's conventions, codified. Each skill is grounded in this repo's real versions, measured output, and failures that actually happened here — not general advice. |
| `agents/verifier.md` | A subagent that runs the full green chain and reports honestly. Exists because verification is long, noisy, and benefits from a context with no investment in the change being good. |
| `hooks/` | Two Node scripts: `guard-env-commit.js` blocks any git command that would stage or commit a `.env` (tested live — it fires); `warn-migration-edit.js` warns when a committed migration file is edited, because executed migrations are immutable. |
| `settings.json` | Committed, shared: hook wiring, a small allow-list for the routine commands, and a deny on reading `.env`. Nothing machine-specific. |
| `settings.local.json` | Yours, gitignored. Copy `settings.local.json.example` if you want extra personal permissions. |

## "I am about to X" → read this first

| About to… | Read |
| --- | --- |
| Add/change a module, controller, provider, DTO, filter, interceptor, or read config | `skills/nest-conventions` |
| Touch anything spatial: geometry columns, SRIDs, spatial queries, GIST indexes, geo validation | `skills/postgis-spatial` |
| Create, edit, run, or revert a migration; change schema | `skills/typeorm-migrations` |
| Write tests, run suites, or declare a change "green" | `skills/testing-verification` |
| Touch the in-memory spatial index, snapshot rebuild/polling, or `area_version` | `docs/ADR/0012-in-memory-spatial-index.md` + the equivalence harness `test/spatial-equivalence.e2e-spec.ts` |
| Touch the presence cache, the no-change fast path, or Redis | `docs/ADR/0013-presence-cache-no-change-fast-path.md` + the provocation spec `test/stale-presence.e2e-spec.ts` |
| Touch the queue topology, partitions, or `infra/rabbitmq/` | `docs/ADR/0014-rabbitmq-topology.md` — the app NEVER declares topology; the partition count is effectively immutable |
| Touch publishing, the 202 contract, or the location event schema | `docs/ADR/0015-publisher-contract.md` — the message is v1 and consumers depend on it; change it only with a version bump |
| Touch the worker, partition ownership, dedup, or ack/nack behaviour | `docs/ADR/0016-worker.md` — ack only after commit; the FK-drop catch stays NARROW — plus `docs/ADR/0017-per-user-parallelism.md`: per-user chains own ordering; no await between a shared-state read and its dependent write |
| Commit | Run the green chain (or the `verifier` agent) first. The full chain is defined in `skills/testing-verification`. |

Claude Code loads skill descriptions automatically and should reach for these on
its own; the table is for humans and for prompting it explicitly when it doesn't.

## Session workflow

- **Start**: nothing to read beyond this file once. Infra up:
  `docker compose up -d`, wait for `(healthy)`. If `.env` is missing:
  `cp .env.example .env` (mind the 5432/5433 port note in it).
- **During**: hooks are passive guardrails; if one blocks or warns, it says
  exactly why and what to do instead.
- **End / before commit**: green chain (`build`, `lint`, `test`, `test:e2e`,
  compose healthy). One commit per coherent change, conventional-commit style —
  see `git log` for the house style.
- **Decisions**: anything a future reader would ask "why is it like this?" about
  goes in `docs/ADR/` (numbered, indexed in `docs/ADR/README.md`). Required when a
  decision constrains future work or rejects an obvious alternative — the bar set
  by ADR-0001 (extension-via-migration). Point-in-time audits live in `docs/`
  (e.g. `POSTGIS_SETUP_REVIEW.md`) and are never rewritten, only annotated.

## Deliberately NOT here

- **No duplication with CLAUDE.md.** Since Phase 0 a CLAUDE.md exists at the
  repo root, and the division is deliberate: skills carry conventions ("how"),
  CLAUDE.md carries decisions and project state ("what we chose and why" —
  scope, numbered decisions pointing at ADRs, phase status, session protocol).
  Neither restates the other; this file remains the tooling onboarding doc.
  (Earlier versions said no CLAUDE.md existed by design — that changed in
  Phase 0.)
- **No lint/format hook on file edits.** Measured on this machine: type-checked
  ESLint takes ~6 s warm, ~13 s cold (~60 s before the repo left OneDrive) even
  for one file. Per-edit that is unusable; lint runs once per change-set instead.
- **No migration-vs-database hook.** Checking whether an edited migration was
  *actually executed* requires a live DB query per edit and fails when Docker is
  down — a hook that blocks unrelated work. The cheap proxy (warn on edits to
  *committed* migrations) ships instead.
- **No reviewer agent.** In a repo this size the skills themselves are the review
  checklist and the main session has more context about the change than a fresh
  agent would. The `verifier` agent exists because running commands is different:
  it needs no context, just discipline.
- **No CI config, no commit-msg enforcement, no coverage gates.** 3-day project;
  the green chain run by a human (or the verifier) covers it. Raise coverage
  thresholds when domain code lands.
