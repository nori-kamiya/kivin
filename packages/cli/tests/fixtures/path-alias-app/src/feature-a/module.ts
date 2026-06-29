import { FeatureAController } from '@feature/feature-a/controller';
import { Module } from '@kivin/decorators';

@Module({
  providers: [],
  controllers: [FeatureAController],
  imports: [],
})
export class FeatureAModule {}
