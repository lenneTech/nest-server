import { DynamicModule, Module, Provider } from '@nestjs/common';
import { getModelToken, ModelDefinition, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { registerModelSchema } from './model-metadata.registry.js';
import { MongooseDataStore } from './mongoose-data-store.js';
import { getPersistedModelOptions, getPersistedModelOptionsByName } from './persisted-model.decorator.js';
import {
  bindStoreToModel,
  getPersistenceRuntime,
  registerDataStore,
  registerPersistedModel,
} from './persistence-runtime.registry.js';
import { getStoreToken } from './persistence.tokens.js';
import { guardRoutedModel } from './routed-model.guard.js';

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
/** A model definition, plus where it is stored when the configuration does not say */
export interface PersistenceModelDefinition extends ModelDefinition {
  /** Source name (a key of `database.sources`); the configuration's `database.models` wins */
  dataSource?: string;
  /**
   * The model class — its `@PersistedModel({ dataSource })` is read when `dataSource` is not given. Without it, the
   * `@PersistedModel` class named like the model (`name`) is read
   */
  model?: abstract new (...args: any[]) => any;
}

@Module({})
export class CorePersistenceModule {
  static forFeature(models: PersistenceModelDefinition[]): DynamicModule {
    for (const model of models) {
      registerModelSchema(model.name, model.schema);
      registerPersistedModel({
        declaredSource:
          model.dataSource ??
          (model.model ? getPersistedModelOptions(model.model) : getPersistedModelOptionsByName(model.name))
            ?.dataSource,
        name: model.name,
        schema: model.schema,
      });
    }
    const mongoose = MongooseModule.forFeature(
      models.map(({ dataSource: _source, model: _model, ...definition }) => definition),
    );
    const stores: Provider[] = models.map((model) => ({
      inject: [getModelToken(model.name)],
      provide: getStoreToken(model.name),
      // Routed when the store is created, not when the module is declared: feature modules are usually evaluated
      // before `CoreModule.forRoot()` has read the configuration
      useFactory: async (mongooseModel: Model<any>) => {
        const runtime = getPersistenceRuntime();
        const store = runtime
          ? await runtime.resolveStore(model.name, mongooseModel)
          : new MongooseDataStore(mongooseModel);
        registerDataStore(model.name, store);
        bindStoreToModel(mongooseModel, store);
        if (!store.capabilities.mongoosePopulate) {
          guardRoutedModel(mongooseModel, store);
        }
        return store;
      },
    }));
    return {
      exports: [mongoose, ...models.map((model) => getStoreToken(model.name))],
      imports: [mongoose],
      module: CorePersistenceModule,
      providers: stores,
    };
  }
}
