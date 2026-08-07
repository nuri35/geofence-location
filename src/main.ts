import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from '@app/app.module';
import { AppConfig } from '@config/app.config';
import { ConfigNamespace } from '@config/config.constants';

const SWAGGER_PATH = 'docs';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.use(compression());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Geofence Location API')
    .setDescription('Location tracking and geofencing service')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup(SWAGGER_PATH, app, SwaggerModule.createDocument(app, swaggerConfig));

  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const { port } = configService.getOrThrow<AppConfig>(ConfigNamespace.App);

  await app.listen(port);
}

void bootstrap();
