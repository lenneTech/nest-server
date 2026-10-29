import mongoose, { Schema as MongooseSchema } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { UnifiedField } from '../../src/core/common/decorators/unified-field.decorator';
import { CorePersistenceModel } from '../../src/core/common/models/core-persistence.model';
import {
  describeModelClass,
  describeSchema,
  getModelDescriptor,
  registerModelSchema,
} from '../../src/core/common/persistence/model-metadata.registry';
import { DeclaredSchema, declaredSchema } from '../../src/core/common/persistence/mongo/model-declarations';
// The framework's own decorators: they apply @nestjs/mongoose's AND record the declaration, the second source
import { Prop, Schema, SchemaFactory } from '../../src/core/common/persistence/mongo/mongoose-compat';
import { tableName } from '../../src/core/common/persistence/sql/postgres/postgres-schema.compiler';
import { CoreAiBudgetLimit } from '../../src/core/modules/ai/models/core-ai-budget-limit.model';
import { CoreAiConnectionPreference } from '../../src/core/modules/ai/models/core-ai-connection-preference.model';
import { CoreAiConnection } from '../../src/core/modules/ai/models/core-ai-connection.model';
import { CoreAiConversation } from '../../src/core/modules/ai/models/core-ai-conversation.model';
import {
  AiMcpOAuthClientSchema,
  AiMcpOAuthCodeSchema,
  AiMcpOAuthRefreshTokenSchema,
} from '../../src/core/modules/ai/models/core-ai-mcp-oauth.models';
import { CoreAiInteraction } from '../../src/core/modules/ai/models/core-ai-interaction.model';
import { CoreAiMode } from '../../src/core/modules/ai/models/core-ai-mode.model';
import { CoreAiPromptHint } from '../../src/core/modules/ai/models/core-ai-prompt-hint.model';
import { CoreAiPrompt } from '../../src/core/modules/ai/models/core-ai-prompt.model';
import { CoreAiSlot } from '../../src/core/modules/ai/models/core-ai-slot.model';
import { CoreAiToolGrant } from '../../src/core/modules/ai/models/core-ai-tool-grant.model';
import { CoreAiToolPolicy } from '../../src/core/modules/ai/models/core-ai-tool-policy.model';
import { CoreApiTokenModel } from '../../src/core/modules/api-token/core-api-token.model';
import { CoreTenantMemberModel } from '../../src/core/modules/tenant/core-tenant-member.model';
import { FILE_METADATA_MODELS } from '../../src/core/modules/file/file-metadata.models';
import { FileInfo } from '../../src/server/modules/file/file-info.model';
import { User } from '../../src/server/modules/user/user.model';

enum FixtureStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
}

@Schema({ _id: false })
class FixtureAddress {
  @Prop({ type: String })
  city: string;

  @Prop({ type: Number })
  floor: number;
}

/** A nested class WITHOUT @Schema: Mongoose stores it as Mixed, so it must describe as JSON. */
class FixtureLoose {
  note: string;
}

@Schema({ timestamps: true })
class FixtureItem extends CorePersistenceModel {
  @UnifiedField({ isOptional: true, mongoose: { lowercase: true, trim: true, type: String, unique: true } })
  email: string = undefined;

  @UnifiedField({ isOptional: true, mongoose: { default: 3, type: Number } })
  count: number = undefined;

  @Prop({ type: Boolean })
  active: boolean = undefined;

  @Prop({ type: Date })
  when: Date = undefined;

  @UnifiedField({ enum: FixtureStatus, isOptional: true, mongoose: { enum: FixtureStatus, type: String } })
  status: FixtureStatus = undefined;

  @Prop({ type: [String] })
  tags: string[] = undefined;

  @Prop({ type: FixtureAddress })
  address: FixtureAddress = undefined;

  @Prop({ type: [FixtureAddress] })
  addresses: FixtureAddress[] = undefined;

  @Prop({ type: FixtureLoose })
  loose: FixtureLoose = undefined;

  @Prop({ ref: 'User', type: MongooseSchema.Types.ObjectId })
  owner: string = undefined;

  @Prop({ type: [{ ref: 'User', type: MongooseSchema.Types.ObjectId }] })
  members: string[] = undefined;

  @Prop({ type: MongooseSchema.Types.Mixed })
  extra: Record<string, unknown> = undefined;

  @Prop({ select: false, type: String })
  secret: string = undefined;

  @Prop({ type: String })
  tenantId: string = undefined;

  @Prop({ expires: 3600, type: Date })
  expiresAt: Date = undefined;

  @Prop({ of: String, type: Map })
  labels: Map<string, string> = undefined;

  @Prop({ required: true, type: String })
  required: string = undefined;
}

const FixtureItemSchema = SchemaFactory.createForClass(FixtureItem);
FixtureItemSchema.index({ email: 1, tenantId: 1 }, { unique: true });

/** Every persisted model class the framework ships or exercises */
const SHIPPED_MODELS = [
  CoreAiBudgetLimit,
  CoreAiConnection,
  CoreAiConnectionPreference,
  CoreAiConversation,
  CoreAiInteraction,
  CoreAiMode,
  CoreAiPrompt,
  CoreAiPromptHint,
  CoreAiSlot,
  CoreAiToolGrant,
  CoreAiToolPolicy,
  CoreApiTokenModel,
  CoreTenantMemberModel,
  FileInfo,
  User,
];

describe('persistence model descriptor', () => {
  const item = describeSchema('FixtureItem', FixtureItemSchema);
  const field = (name: string) => item.fields[name];

  it('describes scalar kinds and their options', () => {
    expect(field('email')).toMatchObject({ isArray: false, kind: 'string', lowercase: true, trim: true, unique: true });
    expect(field('count')).toMatchObject({ default: 3, hasDefault: true, kind: 'number' });
    expect(field('active').kind).toBe('boolean');
    expect(field('when').kind).toBe('date');
    expect(field('extra').kind).toBe('json');
    expect(field('secret')).toMatchObject({ kind: 'string', select: false });
    expect(field('required')).toMatchObject({ required: true });
    expect(field('email').required).toBe(false);
    expect(field('expiresAt')).toMatchObject({ expiresAfterSeconds: 3600, kind: 'date' });
  });

  it('describes enums with their values and base type', () => {
    expect(field('status').kind).toBe('enum');
    expect(field('status').enumBase).toBe('string');
    expect([...field('status').enumValues].sort()).toEqual(['active', 'paused']);
  });

  it('describes arrays by their element kind', () => {
    expect(field('tags')).toMatchObject({ isArray: true, kind: 'string' });
  });

  it('recognises a reference by its ref option, for single values and arrays', () => {
    expect(field('owner')).toMatchObject({ isArray: false, kind: 'ref', ref: 'User' });
    expect(field('members')).toMatchObject({ isArray: true, kind: 'ref', ref: 'User' });
  });

  it('describes a @Schema sub-document as an object with its own fields, single and as array', () => {
    expect(field('address')).toMatchObject({ isArray: false, kind: 'object' });
    expect(field('address').nested.city.kind).toBe('string');
    expect(field('address').nested.floor.kind).toBe('number');
    expect(field('addresses')).toMatchObject({ isArray: true, kind: 'object' });
    expect(field('addresses').nested.city.kind).toBe('string');
  });

  it('describes undeclared nested shapes and maps as JSON', () => {
    expect(field('loose').kind).toBe('json');
    expect(field('labels').kind).toBe('json');
    expect(Object.keys(item.fields).some((name) => name.includes('$*'))).toBe(false);
  });

  it('keeps the id and the inherited timestamps, but no version key', () => {
    expect(field('_id').kind).toBe('id');
    expect(field('createdAt').kind).toBe('date');
    expect(field('updatedAt').kind).toBe('date');
    expect(Object.keys(item.fields)).not.toContain('__v');
    expect(item.timestamps).toBe(true);
  });

  it('marks a schema with a tenantId path as tenant-scoped, exactly like the tenant plugin', () => {
    expect(item.tenantScoped).toBe(true);
    const plain = describeSchema('Plain', new mongoose.Schema({ name: String }));
    expect(plain.tenantScoped).toBe(false);
  });

  it('lists single-field and compound indexes with their options', () => {
    expect(item.indexes).toContainEqual({ fields: { email: 1 }, options: { unique: true } });
    expect(item.indexes).toContainEqual({ fields: { expiresAt: 1 }, options: { expireAfterSeconds: 3600 } });
    expect(item.indexes).toContainEqual({ fields: { email: 1, tenantId: 1 }, options: { unique: true } });
  });

  it('describes a raw nested object (dotted paths) as one object field', () => {
    const raw = describeSchema('Raw', new mongoose.Schema({ meta: { score: Number, source: String } }));
    expect(raw.fields.meta.kind).toBe('object');
    expect(raw.fields.meta.nested.score.kind).toBe('number');
    expect(raw.fields.meta.nested.source.kind).toBe('string');
    expect(raw.fields['meta.score']).toBeUndefined();
  });

  it('describes a class through SchemaFactory, caches it, and registers schemas by model name', () => {
    expect(describeModelClass(FixtureItem)).toBe(describeModelClass(FixtureItem));
    expect(describeModelClass(FixtureItem).name).toBe('FixtureItem');
    registerModelSchema('FixtureRegistered', FixtureItemSchema);
    expect(getModelDescriptor('FixtureRegistered')?.fields.email.kind).toBe('string');
    expect(getModelDescriptor('NotRegistered')).toBeUndefined();
  });

  /**
   * Pins the description of every persisted model the framework ships or exercises. When the descriptor
   * gains a second source (phase 5: `@UnifiedField` without `@nestjs/mongoose`), this snapshot is what
   * proves both sources still agree.
   */
  it('describes every persisted core and reference model', () => {
    const described = Object.fromEntries(SHIPPED_MODELS.map((model) => [model.name, describeModelClass(model)]));
    for (const descriptor of Object.values(described)) {
      expect(descriptor.fields._id?.kind).toBe('id');
    }
    expect(described.User.fields.email.kind).toBe('string');
    expect(described.User.fields.roles.isArray).toBe(true);
    expect(described.CoreTenantMemberModel.tenantScoped).toBe(false);
    expect(described).toMatchSnapshot();
  });

  /**
   * The second source: where Mongoose is not installed (a project on PostgreSQL alone, 12.1.0+), a model is described
   * from what its decorators recorded, through a view that builds paths and indexes as Mongoose does. Field for field
   * and index for index it must answer what Mongoose answers — for every shipped model and for every shape the
   * fixture exercises (scalars, enums, arrays, refs, sub-documents, maps, TTL, unique, sparse, select, compound).
   */
  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — a model described without Mongoose must lose nothing Mongoose would
   *   derive; a lost TTL would leave a SQL table without its expiry sweep.
   * @seen-failing Drop the `expires` handling in src/core/common/persistence/mongo/declared-schema.view.ts — registered
   *   as mutation `declared-view-ignores-expires` in tests/regression-mutations.json.
   */
  it('describes every model the same from its recorded declaration as from its Mongoose schema', () => {
    for (const model of [...SHIPPED_MODELS, FixtureItem, FixtureAddress]) {
      expect(describeSchema(model.name, declaredSchema(model)), model.name).toEqual(describeModelClass(model));
    }
    // The models declared inline (`createSchema()`): the same definition and options, read both ways
    const inline: Array<[string, any]> = [
      ...FILE_METADATA_MODELS.map((model) => [model.name, model.schema] as [string, any]),
      ['AiMcpOAuthClient', AiMcpOAuthClientSchema],
      ['AiMcpOAuthCode', AiMcpOAuthCodeSchema],
      ['AiMcpOAuthRefreshToken', AiMcpOAuthRefreshTokenSchema],
    ];
    for (const [name, schema] of inline) {
      const declared = new DeclaredSchema({ definition: schema.obj, options: schema.options });
      expect(describeSchema(name, declared), name).toEqual(describeSchema(name, schema));
    }
  });

  /**
   * @regression   DEV-3833 (db-agnostic phase 5) — the comparison above builds both sides fresh from the class, so the
   *   compound indexes a module adds afterwards (`TenantMember {user, tenant}`, the upsert keys of the AI grants and
   *   preferences) were compared nowhere: a view that lost them left a SQL table without its unique constraint.
   * @seen-failing Drop the compound indexes from the index list in
   *   src/core/common/persistence/mongo/declared-schema.view.ts — registered as mutation
   *   `declared-view-drops-compound-indexes` in tests/regression-mutations.json.
   */
  it('keeps the compound indexes a module adds after createForClass()', () => {
    const withIndexes = <
      S extends { index(fields: Record<string, number>, options?: Record<string, unknown>): unknown },
    >(
      schema: S,
    ): S => {
      schema.index({ email: 1, tenantId: 1 }, { unique: true });
      schema.index({ tenantId: 1, email: -1 });
      return schema;
    };
    const declared = describeSchema('FixtureItem', withIndexes(declaredSchema(FixtureItem)));
    expect(declared.indexes).toContainEqual(
      expect.objectContaining({
        fields: { email: 1, tenantId: 1 },
        options: expect.objectContaining({ unique: true }),
      }),
    );
    expect(declared).toEqual(describeSchema('FixtureItem', withIndexes(SchemaFactory.createForClass(FixtureItem))));
  });

  it('names the SQL table after the collection, a hyphen as an underscore', () => {
    const inCollection = (collection: string) =>
      tableName(describeSchema('Named', new MongooseSchema({ label: String }, { collection })));

    expect(inCollection('s3-files')).toBe('s3_files');
    expect(inCollection('filesystem-files')).toBe('filesystem_files');
    expect(inCollection('aiMcpOAuthCodes')).toBe('ai_mcp_o_auth_codes');
    // Anything else that is no identifier stays refused rather than guessed at
    expect(() => inCollection('fs.files')).toThrow('cannot be mapped');
  });
});
