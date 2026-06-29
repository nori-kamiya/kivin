import { SharedSchema } from '@feature/feature-a/schemas';
import { ApiResponse, Controller, Get } from '@kivin/decorators';

@Controller('/a')
export class FeatureAController {
  @Get('/')
  @ApiResponse(200, SharedSchema, 'Feature A response')
  list() {
    return { source: 'a' };
  }
}
