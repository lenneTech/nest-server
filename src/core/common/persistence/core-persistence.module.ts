import { DynamicModule, Module, Provider } from '@nestjs/common';
import type { ModelDefinition } from '@nestjs/mongoose';
import { getConnectionToken, getModelToken } from './mongo/mongoose-compat.js';
import type { Model } from 'mongoose';

import { registerModelSchema } from './model-metadata.registry.js';
import { isDeclaredSchema } from './mongo/model-declarations.js';
import { applySyncSchema, assertSyncCollectionReady } from './mongo/sync-schema.plugin.js';
import { MongooseDataStore } from './mongoose-data-store.js';
import {
  getPersistedModelOptions,
  getPersistedModelOptionsByName,
  getPersistedSyncByName,
} from './persisted-model.decorator.js';
import { resolveSyncOptions } from './sync-model.js';
import {
  bindStoreToModel,
  getPersistenceRuntime,
  registerDataStore,
  registerPersistedModel,
} from './persistence-runtime.registry.js';
import { getStoreToken } from './persistence.tokens.js';
import { guardRoutedModel, isStandInModel, standInModel } from './routed-model.guard.js';
import { unavailableStore } from './unavailable-store.js';

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
      const sync = resolveSyncOptions(
        model.model ? getPersistedModelOptions(model.model)?.sync : getPersistedSyncByName(model.name),
        model.name,
      );
      // Described as declared first, then prepared: the descriptor must not see the Mongoose sync paths
      registerModelSchema(model.name, model.schema, sync);
      if (sync && !isDeclaredSchema(model.schema)) {
        applySyncSchema(model.schema, sync);
      }
      registerPersistedModel({
        declaredSource:
          model.dataSource ??
          (model.model ? getPersistedModelOptions(model.model) : getPersistedModelOptionsByName(model.name))
            ?.dataSource,
        name: model.name,
        schema: model.schema,
      });
    }
    // The Mongoose models, as `MongooseModule.forFeature()` registers them (`createMongooseProviders()` of
    // @nestjs/mongoose) — but without requiring a connection: where no MongoDB is configured (`NoMongoConnectionModule`,
    // or none at all) the token gets a stand-in that refuses data access, and the model runs on its routed store.
    const mongooseModels: Provider[] = models.flatMap((model) => [
      {
        inject: [{ optional: true, token: getConnectionToken() }],
        provide: getModelToken(model.name),
        useFactory: (connection?: null | { model: Function; models: Record<string, unknown> }) =>
          connection
            ? (connection.models[model.name] ?? connection.model(model.name, model.schema, model.collection))
            : standInModel(model.name, model.schema),
      },
      ...(model.discriminators ?? []).map((discriminator) => ({
        inject: [getModelToken(model.name)],
        provide: getModelToken(discriminator.name),
        useFactory: (parent: { discriminator: Function }) =>
          parent.discriminator(discriminator.name, discriminator.schema, discriminator.value),
      })),
    ]);
    const stores: Provider[] = models.map((model) => ({
      inject: [getModelToken(model.name)],
      provide: getStoreToken(model.name),
      // Routed when the store is created, not when the module is declared: feature modules are usually evaluated
      // before `CoreModule.forRoot()` has read the configuration
      useFactory: async (mongooseModel: Model<any>) => {
        const runtime = getPersistenceRuntime();
        const store = runtime
          ? await runtime.resolveStore(model.name, mongooseModel)
          : isStandInModel(mongooseModel)
            ? // No SQL source and no MongoDB connection: the project runs without a database (`database: false`)
              unavailableStore(model.name, 'the project runs without a database (`database: false`)')
            : new MongooseDataStore(mongooseModel);
        // A synchronized model on MongoDB: the collection must hold nothing from before it was synchronized
        if (store.capabilities.mongoosePopulate && store.capabilities.changeOrder) {
          await assertSyncCollectionReady(mongooseModel);
        }
        registerDataStore(model.name, store);
        bindStoreToModel(mongooseModel, store);
        // A stand-in already refuses, naming the cause; a real Mongoose model of a model routed elsewhere is made to
        if (!store.capabilities.mongoosePopulate && !isStandInModel(mongooseModel)) {
          guardRoutedModel(mongooseModel, store);
        }
        return store;
      },
    }));
    return {
      exports: [
        ...mongooseModels.map((provider) => (provider as { provide: string }).provide),
        ...stores.map((store) => (store as { provide: string }).provide),
      ],
      module: CorePersistenceModule,
      providers: [...mongooseModels, ...stores],
    };
  }
}
