import { Controller, Get, StaticResponse } from '@kivin/decorators';

const VERSION = '1.2.3';
let counter = 0;

@Controller('/')
export class StaticController {
  private readonly items: string[] = [];

  @Get('/literal')
  literal() {
    return { ok: true, nested: { list: [1, -2, 'three', null, false] }, 'quoted-key': `plain template` };
  }

  @Get('/string')
  text() {
    return 'hello';
  }

  @Get('/time')
  time() {
    return { now: Date.now() };
  }

  @Get('/state')
  state() {
    return this.items;
  }

  @Get('/identifier')
  identifier() {
    return { version: VERSION };
  }

  @Get('/counter')
  count() {
    counter += 1;
    return { counter };
  }

  @Get('/async')
  async later() {
    return { ok: true };
  }

  @Get('/two-statements')
  twoStatements() {
    const value = { ok: true };
    return value;
  }

  @Get('/template')
  template() {
    return `v${VERSION}`;
  }

  @Get('/as-const')
  asConst() {
    return ({ mode: 'ro' } as const) satisfies { mode: string };
  }

  @Get('/declared')
  @StaticResponse()
  declared() {
    return { version: VERSION };
  }
}
