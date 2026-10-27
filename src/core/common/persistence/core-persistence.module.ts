import { DynamicModule, Module, Provider } from '@nestjs/common';
import { getModelToken, ModelDefinition, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { registerModelSchema } from './model-metadata.registry.js';
import { MongooseDataStore } from './mongoose-data-store.js';
import { getStoreToken } from './persistence.tokens.js';

/**
 * Database-neutral model registration — the counterpart of `MongooseModule.forFeature()`.
 *
 * Registers the models exactly as `MongooseModule.forFeature()` does (so `@InjectModel()` keeps working),
 * records each model's descriptor, and provides a data store per model for `@InjectStore()`.
 *
 * @example
 * ```typescript
 * @Module({
 *   imports: [CorePersistenceModule.forFeature([{ name: Project.name, schema: ProjectSchema }])],
 *   providers: [ProjectService],
 * })
 * export class ProjectModule {}
 * ```
 */
@Module({})
export class CorePersistenceModule {
  static forFeature(models: ModelDefinition[]): DynamicModule {
    for (const model of models) {
      registerModelSchema(model.name, model.schema);
    }

    const mongoose = MongooseModule.forFeature(models);
    const stores: Provider[] = models.map((model) => ({
      inject: [getModelToken(model.name)],
      provide: getStoreToken(model.name),
      useFactory: (mongooseModel: Model<any>) => new MongooseDataStore(mongooseModel),
    }));

    return {
      exports: [mongoose, ...models.map((model) => getStoreToken(model.name))],
      imports: [mongoose],
      module: CorePersistenceModule,
      providers: stores,
    };
  }
}
