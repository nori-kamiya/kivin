import { FeatureBController } from '@feature/feature-b/controller';
import { Module } from '@kivin/decorators';

@Module({
  providers: [],
  controllers: [FeatureBController],
  imports: [],
})
export class FeatureBModule {}
