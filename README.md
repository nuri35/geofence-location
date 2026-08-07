# geofence-location

A production-grade NestJS project skeleton for a geofence/location service. It ships
scaffolding and configuration only: typed environment config, TypeORM with
migration-based schema management against PostgreSQL/PostGIS, a wired-but-unused
Redis client, a health endpoint, Swagger, and a global exception filter and
response envelope. No domain modules or business logic exist yet.

## Stack

| Component  | Choice                                          |
| ---------- | ----------------------------------------------- |
| Runtime    | Node.js >= 20                                   |
| Framework  | NestJS 11 (Express 5)                           |
| Language   | TypeScript 5 (strict)                           |
| Database   | PostgreSQL 16 + PostGIS 3.4 (`postgis/postgis`) |
| ORM        | TypeORM 0.3 (DataSource + migrations, no sync)  |
| Cache      | Redis 7 via ioredis                             |
| Validation | class-validator / class-transformer, Joi (env)  |
| Testing    | Jest 29, Supertest (e2e)                        |
| Local infra| Docker Compose                                  |

## Prerequisites

- Node.js 20 or newer and npm
- Docker with Compose v2

## Running locally

```bash
cp .env.example .env        # defaults work with the compose services as-is
docker compose up -d        # PostGIS + Redis with healthchecks
npm install
npm run migration:run       # applies migrations (first one enables the PostGIS extension)
npm run start:dev
```

The API listens on `http://localhost:3000`. Health: `GET /health`. Swagger UI: `/docs`.

## Scripts

| Script                   | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `npm run start:dev`      | Start with file watching                            |
| `npm run build`          | Compile to `dist/`                                  |
| `npm run lint`           | ESLint (type-checked) with autofix                  |
| `npm run format`         | Prettier over `src/` and `test/`                    |
| `npm test`               | Unit tests                                          |
| `npm run test:cov`       | Unit tests with coverage thresholds                 |
| `npm run test:e2e`       | End-to-end tests (requires compose services up)     |
| `npm run migration:generate` | `-- src/migrations/<Name>` to diff entities     |
| `npm run migration:run`  | Apply pending migrations                            |
| `npm run migration:revert` | Roll back the last migration                      |

## Project structure

```
src/
├── app.module.ts            # root module: config, TypeORM, Redis, health, globals
├── main.ts                  # bootstrap: helmet, compression, pipes, Swagger
├── config/                  # ONLY place that reads process.env
│   ├── app.config.ts        # typed 'app' namespace
│   ├── database.config.ts   # typed 'database' namespace
│   ├── redis.config.ts      # typed 'redis' namespace
│   ├── env.validation.ts    # Joi schema for env vars
│   ├── typeorm.config.ts    # TypeOrmModule factory
│   └── data-source.ts       # DataSource for the TypeORM CLI
├── common/
│   ├── filters/             # HttpExceptionFilter (registered globally)
│   ├── interceptors/        # ResponseTransformInterceptor (registered globally)
│   ├── decorators/          # empty, reserved
│   └── dto/                 # empty, reserved
├── health/                  # GET /health (Terminus, db ping)
├── redis/                   # global ioredis provider (REDIS_CLIENT token)
└── migrations/              # TypeORM migrations (0001 enables the PostGIS extension)
test/                        # e2e specs + jest e2e config
docs/ADR/                    # architecture decision records
```

## Environment variables

Required variables have no fallback — the app refuses to start if one is missing.
`cp .env.example .env` provides working values for the compose services.

| Variable            | Required | Default       | Description                                  |
| ------------------- | -------- | ------------- | -------------------------------------------- |
| `NODE_ENV`          | no       | `development` | `development` \| `test` \| `production`      |
| `PORT`              | no       | `3000`        | HTTP port                                    |
| `PRESENCE_READ_STRATEGY` | no  | `two-step`    | ADR 0007 measurement: `two-step` \| `folded` \| `cache` |
| `POSTGRES_HOST`     | yes      | —             | Postgres host                                |
| `POSTGRES_PORT`     | yes      | —             | Postgres port (also used by compose mapping) |
| `POSTGRES_USER`     | yes      | —             | Postgres user                                |
| `POSTGRES_PASSWORD` | yes      | —             | Postgres password                            |
| `POSTGRES_DB`       | yes      | —             | Database name                                |
| `REDIS_HOST`        | yes      | —             | Redis host                                   |
| `REDIS_PORT`        | yes      | —             | Redis port (also used by compose mapping)    |
| `REDIS_PASSWORD`    | no       | *(empty)*     | Redis password; empty disables auth          |
