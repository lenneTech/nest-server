import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { IAiHook } from '../interfaces/ai-hook.interface';
import { AiHookRegistry } from './ai-hook.registry';

/**
 * Convenience base class for AI lifecycle hooks. Extend it, declare the class as
 * a NestJS provider in your module, and override one or more of
 * {@link IAiHook.preToolUse} / `postToolUse` / `sessionStart` / `stop`. The hook
 * auto-registers in the global {@link AiHookRegistry} on module init.
 */
@Injectable()
export abstract class AiHookBase implements IAiHook, OnModuleInit {
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly name: string;

  protected constructor(protected readonly registry: AiHookRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }
}
