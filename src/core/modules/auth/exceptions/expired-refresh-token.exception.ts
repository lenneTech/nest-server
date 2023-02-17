import { UnauthorizedException } from '@nestjs/common';

/**
 * Exception for expired refresh token
 */
export class ExpiredRefreshTokenException extends UnauthorizedException {
  constructor() {
    super('Expired refresh token');
  }
}
