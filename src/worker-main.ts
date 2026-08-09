import { NestFactory } from '@nestjs/core';

import { WorkerModule } from '@app/worker/worker.module';

/**
 * Worker entrypoint (ADR 0016): an application context, not an HTTP server —
 * `node dist/worker-main`. Boot order is enforced by lifecycle hooks: snapshot
 * build and passive queue verification happen in onApplicationBootstrap; a
 * missing topology or unreachable broker aborts the boot loudly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

void bootstrap();
