import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
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
import { CoreAiBudgetLimit } from '../../src/core/modules/ai/models/core-ai-budget-limit.model';
import { CoreAiConnectionPreference } from '../../src/core/modules/ai/models/core-ai-connection-preference.model';
import { CoreAiConnection } from '../../src/core/modules/ai/models/core-ai-connection.model';
import { CoreAiConversation } from '../../src/core/modules/ai/models/core-ai-conversation.model';
import { CoreAiInteraction } from '../../src/core/modules/ai/models/core-ai-interaction.model';
import { CoreAiMode } from '../../src/core/modules/ai/models/core-ai-mode.model';
import { CoreAiPromptHint } from '../../src/core/modules/ai/models/core-ai-prompt-hint.model';
import { CoreAiPrompt } from '../../src/core/modules/ai/models/core-ai-prompt.model';
import { CoreAiSlot } from '../../src/core/modules/ai/models/core-ai-slot.model';
import { CoreAiToolGrant } from '../../src/core/modules/ai/models/core-ai-tool-grant.model';
import { CoreAiToolPolicy } from '../../src/core/modules/ai/models/core-ai-tool-policy.model';
import { CoreApiTokenModel } from '../../src/core/modules/api-token/core-api-token.model';
import { CoreTenantMemberModel } from '../../src/core/modules/tenant/core-tenant-member.model';
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
    const models = [
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
    const described = Object.fromEntries(models.map((model) => [model.name, describeModelClass(model)]));
    for (const descriptor of Object.values(described)) {
      expect(descriptor.fields._id?.kind).toBe('id');
    }
    expect(described.User.fields.email.kind).toBe('string');
    expect(described.User.fields.roles.isArray).toBe(true);
    expect(described.CoreTenantMemberModel.tenantScoped).toBe(false);
    expect(described).toMatchSnapshot();
  });
});
