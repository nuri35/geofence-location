# ADR 0008 — Disable `migration:generate`; schema SQL is written by hand

- **Status**: Accepted
- **Date**: 2026-08-08

## Context

`synchronize` is off and all six migrations in this repository were written by
hand. The migration audit (2026-08-07) ran `migration:generate` as a drift
diagnostic against a schema that is byte-identical to what the chain builds —
and the generated output opened by deleting two load-bearing objects, because
both are structurally invisible to entity metadata:

- **`chk_areas_boundary_valid`** — `CHECK (ST_IsValid(boundary))` on `areas`.
  No entity declares it (TypeORM's `@Check` decorator exists but is not used
  here — see Alternatives), so the differ sees an unknown constraint and plans
  its removal. This CHECK is the database-level last line of defence against
  invalid polygons; the service-layer gate can be bypassed by any future code
  path, which is why the constraint exists (ADR 0003, CLAUDE.md hard
  constraints).
- **`idx_logs_recorded_id`** — `(recorded_at DESC, id DESC)`. `@Index` has no
  per-column sort-order support, so this index **cannot be represented** in
  entity metadata at all. It is the measured 120× on the most common
  `GET /logs` query (41.3 ms → 0.34 ms at 200k rows, ADR 0006).

## The evidence — actual generated SQL, quoted from the audit

```ts
await queryRunner.query(`ALTER TABLE "user_area_presence" DROP CONSTRAINT "fk_presence_area"`);
await queryRunner.query(`ALTER TABLE "logs" DROP CONSTRAINT "fk_logs_area"`);
await queryRunner.query(`DROP INDEX "public"."idx_areas_boundary"`);
await queryRunner.query(`DROP INDEX "public"."idx_logs_recorded_id"`);      // ← the 120× index
await queryRunner.query(`ALTER TABLE "areas" DROP CONSTRAINT "chk_areas_boundary_valid"`); // ← the ST_IsValid backstop
```

(The FK/GIST drops are naming-only churn — TypeORM re-adds identical
definitions under hash names. The two marked lines are real deletions with no
re-add.)

Worse, the generated `down()` recreated the index **wrong**:

```ts
await queryRunner.query(`CREATE INDEX "idx_logs_recorded_id" ON "logs" ("id", "recorded_at") `);
```

Column order inverted, `DESC` lost — a rollback that silently installs a
useless index under the correct name. A broken forward migration fails in
review; a broken rollback fails at 2 a.m.

## Decision

The `migration:generate` npm script is replaced with a refusal that explains
itself at the moment someone reaches for it: what is disabled, why, where the
reasoning lives (here), and what to do instead. `migration:run` and
`migration:revert` are untouched.

The failure mode this closes is not ignorance but habit: generate *looks*
authoritative, and the standard TypeORM workflow — generate, skim, commit —
ships the deletions precisely because the person moving fast enough to rely on
generate is the person who will not re-read a skill first. Documentation warns;
the script now refuses.

**What is lost**: generated SQL for ordinary column changes — a convenience
this project has used zero times in six migrations. The cost is nil today.

**Escape hatch** (deliberate use only, e.g. a large entity refactor): run the
underlying CLI directly — `npm run typeorm -- migration:generate <path>` —
then, before committing, strip every statement touching
`chk_areas_boundary_valid` and `idx_logs_recorded_id`, and treat the remainder
as a draft to be reviewed line by line (the naming-churn drops above show why).

## Alternatives considered

- **Make the objects representable / ignorable and keep generate.** TypeORM
  0.3.31 does offer `@Check` (could express the constraint) and
  `@Index(name, { synchronize: false })` (would hide the index from the
  differ). Rejected: this patches the two *known* invisible objects but leaves
  the class of failure open — the next partially-representable object (a
  partial index, an expression index, a trigger) silently reopens the hole,
  and `synchronize: false` makes entities claim objects they do not describe.
  Given generate has never been used here, keeping it safe buys nothing.
- **Drop `DESC` so the index becomes representable.** Rejected: bending the
  schema to fit the tool's limits. A plain `(recorded_at, id)` index can serve
  backward scans, but the schema would then be shaped by decorator
  expressiveness rather than by the measured query — and the next unrepresentable
  object would demand the same concession again.
- **Documentation only** (the pre-existing state: the skill said "read the
  generated SQL before committing"). Rejected by the audit's own conclusion:
  the most likely way the chain breaks for someone new is exactly this path,
  and a warning inside a skill does not interrupt a generate-skim-commit flow.
  The refusal does.

## Consequences

- Every future schema change is hand-written SQL in a migration, per the
  existing `typeorm-migrations` skill — now stated there as a rule, not a
  preference.
- A companion guard in `test/global-setup.ts` compares its manual migration
  list against `src/migrations/` on disk and fails the e2e suite on mismatch —
  closing the audit's other silent gap (a missing index/constraint migration
  previously passed 8/8 against a diverged test schema).
- If entity-metadata coverage of these objects ever becomes complete in a
  future TypeORM, this ADR is the record of what to re-verify before
  re-enabling anything.
