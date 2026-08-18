import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import { ConfigService } from '../../common/services/config.service';
import { CoreFileController } from './core-file.controller';
import { CoreFileResolver } from './core-file.resolver';
import { CoreFileService } from './core-file.service';
import {
  FILE_ROLE_MEMBERS,
  FileEndpointClassName,
  ObservedFileHandler,
  warnOnUndecidedEffectiveFileAccess,
} from './file-roles.config';

/**
 * Audits the file endpoints a project ACTUALLY registered, and warns when one of them is open beyond
 * platform admins for a reason the configuration cannot show.
 *
 * WHY THIS CANNOT LIVE WHERE THE OTHER FILE WARNINGS LIVE
 * -------------------------------------------------------
 * `warnOnUndecidedFileAccess()` runs in the `CoreFileService` constructor and reads CONFIGURATION.
 * For an inherited member that is exactly right: `applyFileRoles()` writes the configured roles onto
 * the base-class function, the subclass picks them up through the prototype chain, and configuration
 * and reality agree.
 *
 * They stop agreeing when a project RE-DECLARES a member. Decorator metadata lives on the function
 * object, so an override is a different function carrying its own `@Roles()` — and that is the
 * function Nest registers. Answering "is the gate open?" from configuration then answers a question
 * about a route that is not the one being served. Two consumer projects shipped anonymously readable
 * downloads that way, and nothing said a word.
 *
 * Seeing the real answer needs the registered class, and the registered class only exists once Nest
 * has built its route table. Neither the service constructor nor `CoreModule.forRoot()` — which runs
 * before any of that — can reach it. Hence a provider, and hence `onApplicationBootstrap`.
 *
 * WHY DISCOVERY RATHER THAN A CONFIG OPTION
 * ------------------------------------------
 * The file module ships abstract classes only: there is no `CoreFileModule.forRoot()` to hand a class
 * to, and a class reference cannot travel through `config.env.ts` (it has to survive
 * `NEST_SERVER_CONFIG` / `NSC__*`, i.e. JSON). Asking every consumer to register their controller in
 * a second place would also make the audit opt-in — and an opt-in audit is missing precisely where
 * nobody thought about access control, which is the population it exists for.
 *
 * WARNING ONLY. It never changes a role, and deliberately so: rewriting an override's metadata would
 * silently relax a route the project pinned on purpose, which is the trap that rules out adopting the
 * TUS module's approach here. The audit reports; the project decides.
 *
 * Registered as a `CoreModule` provider; consumers never interact with it.
 */
@Injectable()
export class CoreFileAccessAuditInitializer implements OnApplicationBootstrap {
  protected readonly logger = new Logger(CoreFileAccessAuditInitializer.name);

  constructor(@Optional() protected readonly discoveryService?: DiscoveryService) {}

  onApplicationBootstrap(): void {
    if (!this.discoveryService) {
      return;
    }

    const handlers = this.collectHandlers();
    // No file endpoint registered — there is no route to be wrong about, and the configuration-side
    // warning in the service constructor already covers a service-only integration.
    if (!handlers.length) {
      return;
    }

    const config = ConfigService.configFastButReadOnly;
    warnOnUndecidedEffectiveFileAccess({
      fileConfig: config?.file,
      handlers,
      hasPerFileRule: this.hasPerFileRule(),
      multiTenancyEnabled: !!config?.multiTenancy && config.multiTenancy.enabled !== false,
    });
  }

  /**
   * The effective roles of every known member on every registered file endpoint class.
   *
   * `proto[method]` resolves through the prototype chain, so it yields the OVERRIDE when there is one
   * and the inherited base function otherwise — which is exactly the function Nest registered.
   */
  protected collectHandlers(): ObservedFileHandler[] {
    const handlers: ObservedFileHandler[] = [];

    for (const [className, target] of this.registeredEndpointClasses()) {
      for (const member of FILE_ROLE_MEMBERS) {
        if (member.className !== className) {
          continue;
        }

        const fn = (target.prototype as Record<string, unknown>)?.[member.method];
        if (typeof fn !== 'function') {
          continue;
        }

        handlers.push({
          key: member.key,
          member: `${target.name}.${member.method}`,
          roles: this.effectiveRoles(fn, target),
        });
      }
    }

    return handlers;
  }

  /**
   * The union the guards will compute for a member.
   *
   * Mirrors `mergeRolesMetadata([handlerRoles, classRoles])`: both halves count, so a class-level
   * `@Roles()` on the subclass is seen too. `Reflect.getMetadata` walks the prototype chain for the
   * class, which is what makes an undecorated subclass inherit the core `@Roles(ADMIN)` — the same
   * resolution Nest's `Reflector` performs.
   */
  protected effectiveRoles(fn: unknown, target: Function): string[] {
    const handlerRoles: string[] = Reflect.getMetadata('roles', fn as object) ?? [];
    const classRoles: string[] = Reflect.getMetadata('roles', target) ?? [];
    return [...handlerRoles, ...classRoles];
  }

  /** Whether the registered `CoreFileService` overrides `checkRights()` — the project wrote a rule. */
  protected hasPerFileRule(): boolean {
    const services = (this.discoveryService?.getProviders() ?? [])
      .map((wrapper) => wrapper.instance)
      .filter((instance): instance is CoreFileService => instance instanceof CoreFileService);

    return services.some((service) => (service as any).checkRights !== (CoreFileService.prototype as any).checkRights);
  }

  /**
   * Every registered class that IS one of the two file endpoint classes, deduplicated.
   *
   * Read off the instance rather than the wrapper's `metatype`, because that is the object whose
   * prototype chain answers the `instanceof` question reliably for both controllers and providers.
   */
  protected registeredEndpointClasses(): [FileEndpointClassName, Function][] {
    const found = new Map<Function, FileEndpointClassName>();

    const consider = (instance: unknown): void => {
      if (!instance || typeof instance !== 'object') {
        return;
      }
      const target = (instance as object).constructor;
      if (typeof target !== 'function' || found.has(target)) {
        return;
      }
      if (instance instanceof CoreFileController) {
        found.set(target, 'CoreFileController');
      } else if (instance instanceof CoreFileResolver) {
        found.set(target, 'CoreFileResolver');
      }
    };

    for (const wrapper of this.discoveryService?.getControllers() ?? []) {
      consider(wrapper.instance);
    }
    for (const wrapper of this.discoveryService?.getProviders() ?? []) {
      consider(wrapper.instance);
    }

    return [...found].map(([target, className]) => [className, target]);
  }
}
