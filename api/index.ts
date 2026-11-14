import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/swagger';

// Vercel entry point. Vercel runs this file as a serverless function instead of src/main.ts,
// so there's no app.listen(): Nest is booted once per instance and reused across requests.
// Migrations are not run here; run `npm run migrate` against the database once per deploy.
// The WebSocket gateway is disabled on Vercel (see IS_SERVERLESS in src/config/app-config.ts).

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Promise<Handler> | undefined;

async function bootstrap(): Promise<Handler> {
  const app = await NestFactory.create(AppModule);
  setupSwagger(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as Handler;
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  // If boot fails (e.g. database unreachable), retry on the next request instead of caching the error.
  handler ??= bootstrap().catch((err) => {
    handler = undefined;
    throw err;
  });
  (await handler)(req, res);
}
