import { ObjectType } from '@nestjs/graphql';
import { Schema } from '@nestjs/mongoose';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { accessDeniedException } from '../../common/exceptions/access-denied.exception';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';
import { ConfigService } from '../../common/services/config.service';
import { RequestContext } from '../../common/services/request-context.service';
import { checkRoleAccess } from '../tenant/core-tenant.helpers';
import { ApiTokenKind } from './core-api-token.constants';
import { getApiTokenContext, getApiTokenManageRole } from './core-api-token.helpers';

/**
 * API token (`apiTokens` config): a USER token or a TENANT token, see {@link ApiTokenKind}.
 *
 * The secret itself is never stored — only its SHA-256 hash (`secretHash`) and the AES-GCM encrypted
 * signing key for assertions (`signingKeyEncrypted`). Both are `select: false` and `@Restricted(S_NO_ONE)`,
 * so neither a plain query nor a response carries them.
 *
 * The tenant field is `tenant`, not `tenantId` — like `CoreTenantMemberModel` — so the tenant plugin
 * does not filter this collection: authentication has to find a token before any tenant is known, and
 * the service scopes every management query explicitly.
 *
 * Projects extend this model to bind a token to their own data (an upload target, an export setting)
 * and pass the subclass to `CoreApiTokenModule.forRoot({ model })` / `CoreModule` overrides.
 */
@ObjectType({ description: 'API token', isAbstract: true })
@Restricted(RoleEnum.S_USER)
@Schema({ timestamps: true })
export class CoreApiTokenModel extends CorePersistenceModel {
  /** ID of the user who created the token */
  @UnifiedField({
    description: 'ID of the creating user',
    isOptional: true,
    mongoose: { type: String },
    roles: RoleEnum.S_USER,
  })
  createdBy: string = undefined;

  /** Free-text description */
  @UnifiedField({ description: 'Description', isOptional: true, mongoose: { type: String }, roles: RoleEnum.S_USER })
  description: string = undefined;

  /** Expiry; `null` = no expiry */
  @UnifiedField({
    description: 'Expiry date',
    isOptional: true,
    mongoose: { default: null, type: Date },
    roles: RoleEnum.S_USER,
    type: Date,
  })
  expiresAt: Date = undefined;

  /** USER or TENANT */
  @UnifiedField({
    description: 'Token kind',
    mongoose: { enum: Object.values(ApiTokenKind), required: true, type: String },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  kind: ApiTokenKind = undefined;

  /** Last successful use (updated at most once per minute and process) */
  @UnifiedField({
    description: 'Last use',
    isOptional: true,
    mongoose: { default: null, type: Date },
    roles: RoleEnum.S_USER,
    type: Date,
  })
  lastUsedAt: Date = undefined;

  /** USER tokens: the highest tenant role the token may act with (a cap, never a grant) */
  @UnifiedField({
    description: 'Maximum tenant role',
    isOptional: true,
    mongoose: { type: String },
    roles: RoleEnum.S_USER,
  })
  maxTenantRole: string = undefined;

  /** Display name */
  @UnifiedField({ description: 'Name', mongoose: { required: true, type: String }, roles: RoleEnum.S_USER })
  name: string = undefined;

  /** Public part of the token, used for the lookup (not a secret) */
  @UnifiedField({
    description: 'Public token id',
    mongoose: { required: true, type: String, unique: true },
    roles: RoleEnum.S_USER,
  })
  publicId: string = undefined;

  /** Revocation date; a revoked token is refused */
  @UnifiedField({
    description: 'Revocation date',
    isOptional: true,
    mongoose: { default: null, type: Date },
    roles: RoleEnum.S_USER,
    type: Date,
  })
  revokedAt: Date = undefined;

  /** Scopes (subset of `apiTokens.scopes`) */
  @UnifiedField({
    description: 'Scopes',
    isArray: true,
    mongoose: { default: [], type: [String] },
    roles: RoleEnum.S_USER,
    type: () => String,
  })
  scopes: string[] = undefined;

  /** SHA-256 of the token secret — never returned */
  @Restricted(RoleEnum.S_NO_ONE)
  @UnifiedField({
    description: 'Secret hash',
    isOptional: true,
    mongoose: { select: false, type: String },
    roles: RoleEnum.S_NO_ONE,
  })
  secretHash: string = undefined;

  /** AES-256-GCM encrypted signing key for assertions — never returned */
  @Restricted(RoleEnum.S_NO_ONE)
  @UnifiedField({
    description: 'Encrypted signing key',
    isOptional: true,
    mongoose: { select: false, type: String },
    roles: RoleEnum.S_NO_ONE,
  })
  signingKeyEncrypted: string = undefined;

  /** TENANT tokens: the owning tenant. USER tokens: the one tenant the token is restricted to, if any */
  @UnifiedField({
    description: 'Tenant ID',
    isOptional: true,
    mongoose: { index: true, type: String },
    roles: RoleEnum.S_USER,
  })
  tenant: string = undefined;

  /** ID of the user who last changed the token */
  @UnifiedField({
    description: 'ID of the last updating user',
    isOptional: true,
    mongoose: { type: String },
    roles: RoleEnum.S_USER,
  })
  updatedBy: string = undefined;

  /** USER tokens: the owning user */
  @UnifiedField({
    description: 'Owning user ID',
    isOptional: true,
    mongoose: { index: true, type: String },
    roles: RoleEnum.S_USER,
  })
  user: string = undefined;

  /**
   * Who may see a token object:
   * - its owner (USER tokens),
   * - a platform admin (while `multiTenancy.adminBypass` is on, or without multi-tenancy),
   * - a person holding the manage role in the token's tenant (TENANT tokens).
   *
   * A request authenticated WITH a token never sees token objects — tokens do not manage tokens.
   */
  override securityCheck(user: any, force?: boolean): this {
    if (force) return this;
    if (!user) throw accessDeniedException(user);
    if (getApiTokenContext(user)) throw accessDeniedException(user);

    if (this.kind === ApiTokenKind.USER && user.id === this.user) return this;

    const adminBypass = ConfigService.configFastButReadOnly?.multiTenancy?.adminBypass !== false;
    if (adminBypass && user.hasRole?.([RoleEnum.ADMIN])) return this;

    const context = RequestContext.get();
    if (
      this.kind === ApiTokenKind.TENANT &&
      context?.tenantId === this.tenant &&
      context?.tenantRole &&
      checkRoleAccess([getApiTokenManageRole()], undefined, context.tenantRole)
    ) {
      return this;
    }

    throw accessDeniedException(user);
  }
}
