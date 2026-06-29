import {
    ApiResponse,
    Body,
    Controller,
    Delete,
    Description,
    Get,
    OperationId,
    Post,
    Security,
    Summary,
    Tag,
    UseBodySchema,
    UseParamSchema,
    UseQuerySchema,
} from '@kivin/decorators';
import {
    ContractListSchema,
    ContractPathSchema,
    ContractQuerySchema,
    ContractSchema,
    CreateRevisionSchema,
    ErrorSchema,
} from './schemas';

@Controller('/contracts')
@Tag('Contracts')
export class ContractController {
  @Get('/')
  @Summary('List contracts')
  @Description('Lists contracts with required query state and optional search.')
  @OperationId('contracts.list')
  @UseQuerySchema(ContractQuerySchema)
  @ApiResponse(200, ContractListSchema, 'Contract list')
  list() {
    return [];
  }

  @Post('/:id')
  @Tag('Mutations')
  @Summary('Create contract revision')
  @Description('Creates a revision for a contract id.')
  @OperationId('contracts.createRevision')
  @UseParamSchema(ContractPathSchema)
  @UseBodySchema(CreateRevisionSchema)
  @Security('bearerAuth', ['contracts:write'])
  @Security('apiKeyAuth')
  @ApiResponse(202, ContractSchema, 'Revision accepted')
  @ApiResponse(400, ErrorSchema, 'Bad request')
  createRevision(@Body() _input: unknown) {
    return {
      id: 'contract-1',
      revisionId: 'rev-1',
      title: 'Revision',
      labels: ['draft'],
    };
  }

  @Delete('/:id')
  @Summary('Delete contract')
  @Description('Deletes a contract and returns no content.')
  @OperationId('contracts.delete')
  @UseParamSchema(ContractPathSchema)
  @Security('bearerAuth', ['contracts:delete'])
  @ApiResponse(204, 'Deleted')
  @ApiResponse(404, ErrorSchema, 'Missing contract')
  remove() {
    return undefined;
  }
}