import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

// Shared by main.ts and the tests so both run the app the same way.
export function configureApp(app: INestApplication): INestApplication {
  // plain WebSocket (ws) rather than Socket.IO, so any client can connect without a library
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  return app;
}
