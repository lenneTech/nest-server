import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator';
import { RoleEnum } from '../../../common/enums/role.enum';

/**
 * A connection the current user/tenant may use, in a non-sensitive shape safe to
 * return to any authenticated user (no API key, no base URL).
 *
 * Returned by the `aiAvailableConnections` query / `GET /ai/connections/available`
 * so a client can offer a connection picker. `selected` marks the connection that
 * the resolution chain currently resolves to for the caller; `locked` signals that
 * the selection is dictated by a mandatory layer (admin- or tenant-enforced) and
 * cannot be overridden by the user.
 */
@ObjectType({ description: 'An AI connection available to the current user/tenant' })
@Restricted(RoleEnum.S_USER)
export class CoreAiAvailableConnection {
  /** The connection id. */
  @Field(() => String, { description: 'The connection id' })
  id: string;

  /** Whether this is the global default connection. */
  @Field(() => Boolean, { description: 'Whether this is the global default connection' })
  isDefault: boolean;

  /** Whether the selection is dictated by a mandatory layer (cannot be changed by the user). */
  @Field(() => Boolean, { description: 'Whether the selection is enforced and cannot be changed by the user' })
  locked: boolean;

  /** The model id used by the connection (for display). */
  @Field(() => String, { description: 'The model id used by the connection', nullable: true })
  model?: string;

  /** The display name of the connection. */
  @Field(() => String, { description: 'The display name of the connection', nullable: true })
  name?: string;

  /** Whether this connection is the one currently resolved for the caller. */
  @Field(() => Boolean, { description: 'Whether this connection is currently resolved for the caller' })
  selected: boolean;
}
