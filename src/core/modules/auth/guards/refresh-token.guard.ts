import { Injectable } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

@Injectable()
export class RefreshTokenGuard extends AuthGuard('jwt-refresh') {}
