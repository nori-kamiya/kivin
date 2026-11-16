import { Controller, Get, Injectable } from '@kivinjs/decorators';
import { DATABASE, type Database } from './db';

@Controller('/items')
@Injectable({ deps: [DATABASE] })
export class ItemsController {
  constructor(private readonly db: Database) {
    throw new Error(`ItemsController was constructed during kivin generate (${typeof this.db})`);
  }

  @Get('/')
  list() {
    return this.db.query('select * from items');
  }
}
