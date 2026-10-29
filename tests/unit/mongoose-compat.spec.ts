import * as nestMongoose from '@nestjs/mongoose';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { HexObjectId } from '../../src/core/common/persistence/mongo/hex-object-id';
import {
  declaredProps,
  declaredSchema,
  declaredSchemaOptions,
  isDeclaredSchema,
} from '../../src/core/common/persistence/mongo/model-declarations';
import { optionalMongoPackages } from '../../src/core/common/persistence/mongo/mongo-packages';
import {
  createSchema,
  getConnectionToken,
  getModelToken,
  isValidObjectId,
  newObjectId,
  objectIdType,
  Prop,
  raw,
  Schema,
  SchemaFactory,
} from '../../src/core/common/persistence/mongo/mongoose-compat';

/**
 * The core declares its models and injections through `mongoose-compat.ts`, so that it loads where MongoDB's libraries
 * are not installed. Where they ARE installed, nothing may change: the same tokens, the same Mongoose instances, the
 * real decorators applied at the same moment. That half is what this spec pins; the other half (loading without the
 * packages) is proven against the built package by `scripts/check-without-mongodb.mjs`.
 */
describe('mongoose compat', () => {
  it('computes the DI tokens exactly as @nestjs/mongoose does', () => {
    for (const connection of [undefined, 'DatabaseConnection', 'logs', '']) {
      expect(getConnectionToken(connection)).toBe(nestMongoose.getConnectionToken(connection));
      expect(getModelToken('User', connection)).toBe(nestMongoose.getModelToken('User', connection));
    }
  });

  it('loads the installed packages as the very instances a static import sees', () => {
    const packages = optionalMongoPackages();
    expect(packages?.mongoose).toBe(mongoose);
    expect(packages?.nestMongoose.SchemaFactory).toBe(nestMongoose.SchemaFactory);
    expect(packages?.mongodb.ObjectId).toBe(mongoose.mongo.ObjectId);
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — the framework's decorators must still apply @nestjs/mongoose's where
   *   it is installed, or every MongoDB schema loses the fields the core declares.
   * @seen-failing Skip the real `Prop()` in src/core/common/persistence/mongo/mongoose-compat.ts — registered as mutation
   *   `compat-prop-skips-mongoose` in tests/regression-mutations.json.
   */
  it('applies the real decorators and records the declaration', () => {
    @Schema({ collection: 'compat_things', timestamps: true })
    class CompatThing {
      @Prop({ type: String, unique: true })
      name: string;

      @Prop()
      count: number;
    }

    const schema = SchemaFactory.createForClass(CompatThing);
    expect(schema).toBeInstanceOf(mongoose.Schema);
    expect(schema.path('name')?.instance).toBe('String');
    expect(schema.path('count')?.instance).toBe('Number');
    expect(schema.get('collection')).toBe('compat_things');

    expect(declaredSchemaOptions(CompatThing)).toEqual({ collection: 'compat_things', timestamps: true });
    expect(declaredProps(CompatThing)).toEqual([
      { designType: String, key: 'name', options: { type: String, unique: true } },
      { designType: Number, key: 'count', options: {} },
    ]);
  });

  it('records a subclass over its parent, a redeclared property replacing the inherited one', () => {
    @Schema()
    class CompatBase {
      @Prop({ type: String })
      label: string;

      @Prop({ type: Number })
      rank: number;
    }
    @Schema()
    class CompatChild extends CompatBase {
      @Prop({ index: true, type: String })
      override label: string = undefined;

      @Prop({ type: Boolean })
      active: boolean;
    }
    expect(declaredProps(CompatChild).map((prop) => [prop.key, prop.options])).toEqual([
      ['label', { index: true, type: String }],
      ['rank', { type: Number }],
      ['active', { type: Boolean }],
    ]);
    expect(declaredProps(CompatBase).map((prop) => prop.key)).toEqual(['label', 'rank']);
  });

  it('builds Mongoose schemas, ObjectIds and raw definitions with the installed packages', () => {
    expect(createSchema({ label: String }, { collection: 'inline' })).toBeInstanceOf(mongoose.Schema);
    expect(objectIdType()).toBe(mongoose.Schema.Types.ObjectId);
    const id = newObjectId();
    expect(id).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(newObjectId(id.toHexString()).equals(id)).toBe(true);
    expect(isValidObjectId(id.toHexString())).toBe(true);
    expect(isValidObjectId('not-an-id')).toBe(false);
    expect(raw({ score: Number })).toEqual(nestMongoose.raw({ score: Number }));
  });

  it('keeps a declaration where Mongoose is absent: the class, the inline definition and the compound indexes', () => {
    @Schema({ timestamps: true })
    class CompatDeclared {
      @Prop({ type: String })
      title: string;
    }
    const fromClass = declaredSchema(CompatDeclared).index({ title: 1, createdAt: -1 }, { unique: true });
    expect(isDeclaredSchema(fromClass)).toBe(true);
    expect(fromClass.declaration).toEqual({ modelClass: CompatDeclared, options: { timestamps: true } });
    expect(fromClass.indexes).toEqual([[{ createdAt: -1, title: 1 }, { unique: true }]]);
    // The document-lifecycle methods a model file calls are accepted and do nothing without Mongoose
    expect(fromClass.pre().post().plugin().set()).toBe(fromClass);
    expect(isDeclaredSchema(SchemaFactory.createForClass(CompatDeclared))).toBe(false);
  });

  it('has an ObjectId stand-in with the same format and the members the framework reads', () => {
    const id = new HexObjectId();
    expect(id.toHexString()).toMatch(/^[0-9a-f]{24}$/);
    expect(String(id)).toBe(id.toHexString());
    expect(JSON.stringify({ id })).toBe(`{"id":"${id.toHexString()}"}`);
    expect(new HexObjectId(id.toHexString().toUpperCase()).equals(id)).toBe(true);
    expect(new HexObjectId(new mongoose.Types.ObjectId(id.toHexString())).equals(id)).toBe(true);
    expect(Math.abs(id.getTimestamp().getTime() - Date.now())).toBeLessThan(5000);
    expect(() => new HexObjectId('xyz')).toThrow(/24 character hex string/);
    expect(new HexObjectId().toHexString()).not.toBe(id.toHexString());
  });
});
