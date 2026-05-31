import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';

export type AiConnectionPreferenceDocument = CoreAiConnectionPreference & Document;

/**
 * A connection preference for a tenant or a user — the configurable layers of the
 * connection-resolution chain that are NOT platform-admin connection flags:
 *
 * - `scope: 'tenant'`, `enforced: false` → the tenant's default connection (layer 2)
 * - `scope: 'user'` → the user's default connection (layer 3)
 * - `scope: 'tenant'`, `enforced: true` → tenant-enforced connection (layer 5)
 *
 * `refId` is the tenant id or user id. Unique per `(scope, refId)`.
 */
@MongooseSchema({ collection: 'aiConnectionPreferences', timestamps: true })
@ObjectType({ description: 'AI connection preference for a tenant or user' })
@Restricted(RoleEnum.ADMIN)
export class CoreAiConnectionPreference extends CorePersistenceModel {
  /**
   * The selected connection id.
   */
  @UnifiedField({
    description: 'The selected connection id',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  connectionId: string = undefined;

  /**
   * For tenant scope: whether the connection is enforced (mandatory for the tenant's
   * users, overriding user/client selection). Ignored for user scope.
   */
  @UnifiedField({
    description: 'Whether the tenant connection is enforced (tenant scope only)',
    isOptional: true,
    mongoose: { default: false },
    roles: RoleEnum.ADMIN,
    type: () => Boolean,
  })
  enforced?: boolean = undefined;

  /**
   * The tenant id or user id this preference belongs to.
   */
  @UnifiedField({
    description: 'The tenant id or user id this preference belongs to',
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  refId: string = undefined;

  /**
   * Scope of the preference: 'tenant' or 'user'.
   */
  @UnifiedField({
    description: "Scope of the preference: 'tenant' or 'user'",
    mongoose: true,
    roles: RoleEnum.ADMIN,
  })
  scope: string = undefined;
}

export const AiConnectionPreferenceSchema = SchemaFactory.createForClass(CoreAiConnectionPreference);
// One preference per (scope, refId).
AiConnectionPreferenceSchema.index({ scope: 1, refId: 1 }, { unique: true });
