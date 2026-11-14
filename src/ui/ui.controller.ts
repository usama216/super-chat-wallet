import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Simple test page at / so the whole flow can be tried from the browser.
const PAGE = readFileSync(join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

@ApiExcludeController()
@Controller()
export class UiController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  index() {
    return PAGE;
  }
}
