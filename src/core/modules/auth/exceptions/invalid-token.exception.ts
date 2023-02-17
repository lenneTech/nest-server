import { UnauthorizedException } from '@nestjs/common';

/**
 * Exception for invalid token
 */
export class InvalidTokenException extends UnauthorizedException {
  constructor() {
    super('Invalid token');
  }
}
