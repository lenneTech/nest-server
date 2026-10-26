import { Injectable } from '@nestjs/common';

import { AuthGuard } from './auth.guard.js';

@Injectable()
export class RefreshTokenGuard extends AuthGuard('jwt-refresh') {}
