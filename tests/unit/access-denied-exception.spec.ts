import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';

import { accessDeniedException } from '../../src/core/common/exceptions/access-denied.exception';
import { ErrorCode } from '../../src/core/modules/error-code/error-codes';

/**
 * accessDeniedException centralizes the 401/403 decision of the rights checks
 * (check() / checkRestricted() / roles processing in prepareInput): 403 for
 * authenticated requesters (permission problem), 401 only when unauthenticated.
 *
 * Two contracts must hold, and a previous implementation (a custom `HttpException`
 * subclass) silently broke both:
 *
 *   1. TYPE IDENTITY — the result must BE a native ForbiddenException /
 *      UnauthorizedException, so `instanceof` checks and `@Catch(...)` filters in
 *      consuming projects keep firing. Asserting on status and body alone cannot
 *      detect a broken type — which is exactly how that regression slipped through.
 *   2. WIRE FORMAT — `HttpExceptionLogFilter` serializes `{ ...exception }`, so the
 *      exception's own `name` is client-visible on every REST error. It must stay
 *      'ForbiddenException' / 'UnauthorizedException'.
 */
describe('accessDeniedException', () => {
  describe('authenticated requester → 403 Forbidden', () => {
    it('is a native ForbiddenException (instanceof must hold for consumer @Catch filters)', () => {
      const exception = accessDeniedException({ id: 'user-1' });

      expect(exception).toBeInstanceOf(ForbiddenException);
      expect(exception).toBeInstanceOf(HttpException);
      expect(exception).not.toBeInstanceOf(UnauthorizedException);
      expect(exception.getStatus()).toEqual(403);
    });

    it('defaults to the translatable ErrorCode the role guards throw', () => {
      expect(accessDeniedException({ id: 'user-1' }).getResponse()).toEqual(
        new ForbiddenException(ErrorCode.ACCESS_DENIED).getResponse(),
      );
    });

    it('keeps the REST wire format identical to the native exception', () => {
      // HttpExceptionLogFilter spreads the exception, so `name` reaches the client
      expect({ ...accessDeniedException({ id: 'user-1' }) }).toEqual({
        ...new ForbiddenException(ErrorCode.ACCESS_DENIED),
      });
    });

    it('treats falsy-but-present ids (0, empty string) as authenticated', () => {
      // Consumer projects may use numeric ids; `!!user?.id` would hand them a 401
      for (const id of [0, '', false]) {
        expect(accessDeniedException({ id }).getStatus()).toEqual(403);
      }
    });
  });

  describe('unauthenticated requester → 401 Unauthorized', () => {
    it('is a native UnauthorizedException for undefined, null and a user without id', () => {
      for (const user of [undefined, null, {}, { id: undefined }, { id: null }]) {
        const exception = accessDeniedException(user);

        expect(exception).toBeInstanceOf(UnauthorizedException);
        expect(exception).not.toBeInstanceOf(ForbiddenException);
        expect(exception.getStatus()).toEqual(401);
      }
    });

    it('defaults to the translatable ErrorCode the role guards throw', () => {
      expect(accessDeniedException(undefined).getResponse()).toEqual(
        new UnauthorizedException(ErrorCode.UNAUTHORIZED).getResponse(),
      );
    });

    it('keeps the REST wire format identical to the native exception', () => {
      expect({ ...accessDeniedException(undefined) }).toEqual({ ...new UnauthorizedException(ErrorCode.UNAUTHORIZED) });
    });
  });

  it('accepts an explicit message override on both branches', () => {
    expect(accessDeniedException({ id: 'user-1' }, 'Custom').getResponse()).toEqual(
      new ForbiddenException('Custom').getResponse(),
    );
    expect(accessDeniedException(undefined, 'Custom').getResponse()).toEqual(
      new UnauthorizedException('Custom').getResponse(),
    );
  });
});
