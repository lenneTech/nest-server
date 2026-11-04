import { Field, ObjectType } from '@nestjs/graphql';

import { Restricted } from '../../../common/decorators/restricted.decorator.js';
import { RoleEnum } from '../../../common/enums/role.enum.js';

/**
 * What the AI module offers on this server (12.3.1+). Answer of the public `GET /ai/status`, which exists only while
 * the module is registered — a `404` there is the answer "AI is off". Names no user data.
 */
@ObjectType({ description: 'What the AI module offers on this server' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreAiStatus {
  /** Whether the MCP server answers at `/ai/mcp` (`ai.mcp`). */
  @Field(() => Boolean, { description: 'Whether the MCP server answers at /ai/mcp' })
  mcp: boolean;
}
