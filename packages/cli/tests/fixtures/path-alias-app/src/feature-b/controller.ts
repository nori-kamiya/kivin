import { SharedSchema } from '@feature/feature-b/schemas';
import { ApiResponse, Controller, Get } from '@kivin/decorators';

@Controller('/b')
export class FeatureBController {
  @Get('/')
  @ApiResponse(200, SharedSchema, 'Feature B response')
  list() {
    return { source: 'b' };
  }
}
