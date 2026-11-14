import { applyDecorators, INestApplication } from '@nestjs/common';
import { ApiHeader, ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const USER_ID_AUTH = 'x-user-id';

export const DEMO_ADMIN_ID = '00000000-0000-0000-0000-00000000ad01';

// Docs only; the header itself is enforced by @IdempotencyKey().
export function ApiIdempotent() {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Unique per intended operation (e.g. a UUID). Reuse it to safely retry: the operation runs once.',
      example: 'key-001',
    }),
    ApiResponse({ status: 200, description: 'Retry of an earlier request: original result, nothing charged again' }),
    ApiResponse({ status: 400, description: 'Missing/invalid Idempotency-Key or invalid body' }),
    ApiResponse({ status: 422, description: 'Idempotency-Key already used with a different body' }),
  );
}

// Swagger UI at /docs, OpenAPI JSON at /docs-json. "Authorize" sets x-user-id for all requests.
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Super Chat Wallet API')
    .setDescription(
      [
        'Token wallet + live-stream Super Chats on a double-entry ledger.',
        '',
        '**How to try it**',
        '1. `POST /users` twice: one creator, one viewer. Copy the returned ids.',
        '2. Click **Authorize**, paste a user id as `x-user-id`. (Authorize again to switch user.)',
        '3. Money-moving POSTs need an **Idempotency-Key** header: any unique string, e.g. `buy-001`.',
        '   Send the same request again with the same key: you get **200** + `Idempotent-Replayed: true`',
        '   and nothing is charged twice.',
        '',
        `**Demo admin** (for /admin endpoints): \`${DEMO_ADMIN_ID}\``,
        '',
        'Live Super Chats: WebSocket at `ws://<host>/ws`, send',
        '`{"event":"subscribe","data":{"streamId":"<id>"}}`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'x-user-id', description: 'User id (mock auth)' },
      USER_ID_AUTH,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    // persistAuthorization keeps the entered x-user-id across reloads
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });
}
