import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { getContextData } from '../../common/helpers/context.helper';

/**
 * Get current tokens
 */
export const Tokens = createParamDecorator(
  (
    tokenId: 'token' | 'refreshToken' | undefined,
    ctx: ExecutionContext
  ): string | { token: string; refreshToken: string } => {
    // Get prepared context (REST or GraphQL)
    const context = getContextData(ctx);

    // Get token from cookie or authorization header
    const token =
      context?.request?.cookies?.['token'] ||
      context?.request
        ?.get('Authorization')
        ?.replace(/bearer/i, '')
        .trim();

    // Refresh token from cookie or authorization header (the authorization header does not distinguish the tokens)
    const refreshToken = context?.request?.cookies?.['refreshToken'] || token;

    // Set tokens
    const tokens = { token, refreshToken };

    // Return tokens
    if (tokenId?.length) {
      return tokens[tokenId];
    }
    return tokens;
  }
);
