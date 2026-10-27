import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { CorePersistenceModule } from '../../src/core/common/persistence/core-persistence.module';
import { MongooseDataStore } from '../../src/core/common/persistence/mongoose-data-store';
import { getStoreToken } from '../../src/core/common/persistence/persistence.tokens';
import { CrudService } from '../../src/core/common/services/crud.service';

const fakeModel = (modelName: string) => ({ modelName }) as any;

class ConstructorService extends CrudService<any> {
  constructor(model: any) {
    super({ mainDbModel: model } as any);
  }
  store() {
    return this.dataStore;
  }
}

/** The pattern of older projects: the model is assigned after super(). */
class LateAssignmentService extends CrudService<any> {
  constructor(model: any) {
    super();
    this.mainDbModel = model;
  }
  store() {
    return this.dataStore;
  }
  swap(model: any) {
    this.mainDbModel = model;
  }
}

describe('data store wiring', () => {
  it('gives every service with a main model a MongoDB data store', () => {
    const store = new ConstructorService(fakeModel('Thing')).store();
    expect(store).toBeInstanceOf(MongooseDataStore);
    expect(store.modelName).toBe('Thing');
    expect(store.capabilities.mongoosePopulate).toBe(true);
  });

  it('derives the store at access time, so a model assigned after super() is covered too', () => {
    const service = new LateAssignmentService(fakeModel('Late'));
    expect(service.store()?.modelName).toBe('Late');
  });

  it('follows a replaced main model instead of keeping a stale store', () => {
    const service = new LateAssignmentService(fakeModel('First'));
    const first = service.store();
    expect(service.store()).toBe(first);
    service.swap(fakeModel('Second'));
    expect(service.store()?.modelName).toBe('Second');
  });

  it('has no store without a model', () => {
    expect(new LateAssignmentService(undefined).store()).toBeUndefined();
  });

  it('provides and exports one store token per model from forFeature()', () => {
    const module = CorePersistenceModule.forFeature([{ name: 'Alpha', schema: new mongoose.Schema({ name: String }) }]);
    expect(module.exports).toContain(getStoreToken('Alpha'));
    expect((module.providers as any[]).map((provider) => provider.provide)).toEqual([getStoreToken('Alpha')]);
  });
});
