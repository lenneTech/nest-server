import { UnauthorizedException } from '@nestjs/common';

/**
 * Exception for expired token
 */
export class ExpiredTokenException extends UnauthorizedException {
  constructor() {
    super('Expired token');
  }
}
