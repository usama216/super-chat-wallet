import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

// public/index.html is written as a page body (so the same file can also be shared as a
// standalone demo), so it gets wrapped in a document here.
const APP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8')}
</body>
</html>`;

const CONSOLE = readFileSync(join(PUBLIC_DIR, 'console.html'), 'utf8');

// Test pages: the live gifting app at / and the step-by-step console at /console.
@ApiExcludeController()
@Controller()
export class UiController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  app() {
    return APP;
  }

  @Get('console')
  @Header('content-type', 'text/html; charset=utf-8')
  console() {
    return CONSOLE;
  }
}
