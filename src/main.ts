import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { DatabaseService } from './database/database.service';
import { runMigrations } from './database/migrator';
import { setupSwagger } from './swagger';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  const logger = new Logger('Bootstrap');

  // migrate before accepting traffic
  await runMigrations(app.get(DatabaseService).pool, undefined, (m) => logger.log(m));

  setupSwagger(app);

  const { port } = app.get<AppConfig>(APP_CONFIG);
  await app.listen(port);
  logger.log(`Listening on http://localhost:${port} (WebSocket: ws://localhost:${port}/ws)`);
  logger.log(`API docs: http://localhost:${port}/docs`);
}

bootstrap();
