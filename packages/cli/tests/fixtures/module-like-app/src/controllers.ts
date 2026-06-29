import { ApiResponse, Controller, Get } from '@kivin/decorators';
import * as v from 'valibot';

const PingSchema = v.object({
  ok: v.literal(true),
});

@Controller('/inline')
export class InlineController {
  @Get('/')
  @ApiResponse(200, PingSchema, 'Inline module response')
  list() {
    return { ok: true };
  }
}

@Controller('/inline-second')
export class InlineSecondController {
  @Get('/')
  @ApiResponse(200, PingSchema, 'Inline second module response')
  list() {
    return { ok: true };
  }
}
