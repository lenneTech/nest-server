import { RoleEnum } from '../../../common/enums/role.enum.js';

/** A user the AI module authenticated itself (an MCP OAuth access token), as the guards and models expect one. */
export interface AiVerifiedUser {
  [key: string]: any;
  _authenticatedViaBetterAuth: true;
  hasRole(roles: string | string[]): boolean;
  id: string;
  roles: string[];
}

/**
 * The user an MCP OAuth access token belongs to, shaped like a user the authentication middleware sets (12.10.0).
 *
 * `loadUser()` answers a plain `{ id, roles }`. On `/ai/mcp` that object became `request.user`, and two things expected
 * more of it: `RolesGuard` (three-argument `CoreModule.forRoot()`) decides on an existing user only when it carries
 * `_authenticatedViaBetterAuth` — otherwise it asks Passport, which knows no MCP token, and answers 401 — and a model's
 * `securityCheck(user)` calls `user.hasRole()`. Both now run on an MCP OAuth user: the guards when a tool is an
 * `@AgentFunction()` (`ai.agentFunctions`) or a `@nestjs/mcp` tool, `securityCheck()` when an MCP tool result is
 * sanitised. `hasRole()` follows `CoreBetterAuthUserMapper`: `S_EVERYONE` / `S_USER` true, `S_NO_ONE` false,
 * `S_VERIFIED` false (the token says nothing about verification — fail closed), else the user's own roles.
 *
 * A user that already carries both is returned as it is.
 */
export function toVerifiedAiUser<T extends { [key: string]: any; id: string; roles?: string[] }>(
  user: T,
): AiVerifiedUser & T {
  if (user._authenticatedViaBetterAuth === true && typeof user.hasRole === 'function') {
    return user as AiVerifiedUser & T;
  }
  const roles = Array.isArray(user.roles) ? [...user.roles] : [];
  return {
    ...user,
    _authenticatedViaBetterAuth: true,
    hasRole: (check: string | string[]) => {
      const required = Array.isArray(check) ? check : [check];
      if (required.includes(RoleEnum.S_EVERYONE) || required.includes(RoleEnum.S_USER)) {
        return true;
      }
      if (required.includes(RoleEnum.S_NO_ONE) || required.includes(RoleEnum.S_VERIFIED)) {
        return false;
      }
      return required.some((role) => roles.includes(role));
    },
    roles,
  };
}
