import { All, Controller, Logger, Options, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { SkipTenantCheck } from '../tenant/core-tenant.decorators';
import { CoreTusService } from './core-tus.service';

/**
 * Core TUS Controller
 *
 * Handles all TUS protocol requests and delegates to the @tus/server handler.
 *
 * SECURITY: requires a signed-in caller (`S_USER`) by default. Configure via
 * `tus: { roles: [...] }` — `TusModule.forRoot()` writes the configured roles
 * onto these handlers at module-build time, so the decorators below are the
 * fallback for a controller built outside that path, not the effective value.
 *
 * The default used to be `S_EVERYONE`, which the roles guard turns into an
 * unconditional `return true` WITHOUT authenticating. Since a tus upload writes
 * into the same shared GridFS bucket the file download routes read from, and
 * the termination extension is on by default, that meant anonymous callers
 * could fill — and delete from — a store only privileged callers may read.
 *
 * Projects that genuinely need anonymous uploads should say so explicitly:
 *
 * @example
 * ```typescript
 * // config.env.ts
 * tus: { roles: [RoleEnum.S_EVERYONE] }
 * ```
 */
/**
 * TENANT SCOPING: the same reasoning as `CoreFileController` — a tus upload lands in
 * the SAME store the file routes read, and that store is reached through the native
 * driver, so `mongooseTenantPlugin` never scopes it. Without this decorator a
 * configured non-system `tus.roles` (e.g. `['admin']`) is resolved against
 * `membership.role`, which would let a workspace "admin" of ANY tenant write into —
 * and, via the termination extension, delete from — a store that has no tenant
 * boundary at all.
 */
@Controller('tus')
@Roles(RoleEnum.S_USER)
@SkipTenantCheck()
export class CoreTusController {
  private readonly logger = new Logger(CoreTusController.name);

  constructor(protected readonly tusService: CoreTusService) {}

  /**
   * Answer the tus discovery / CORS preflight request.
   *
   * DELIBERATELY UNAUTHENTICATED, and it must stay that way: a browser sends the
   * CORS preflight WITHOUT credentials, by specification. Gating OPTIONS behind
   * `tus.roles` would make every browser upload fail at the preflight — the
   * endpoint would be unreachable from a web client no matter how valid the
   * caller's session is.
   *
   * Nothing is disclosed: the response carries only server capabilities
   * (`Tus-Version`, `Tus-Extension`, `Tus-Max-Size`), never upload data or the
   * existence of any particular upload. `roles` is not applied to this handler.
   *
   * Declared before the `@All()` handlers so it wins the route match.
   */
  @Options()
  @Roles(RoleEnum.S_EVERYONE)
  async handleTusOptions(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handleTus(req, res);
  }

  /**
   * Answer the tus discovery / CORS preflight for an upload-specific URL.
   *
   * Same reasoning as {@link handleTusOptions}. `@tus/server` answers OPTIONS
   * identically regardless of the id, so this leaks no information about whether
   * the upload exists.
   */
  @Options(':id')
  @Roles(RoleEnum.S_EVERYONE)
  async handleTusOptionsWithId(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handleTus(req, res);
  }

  /**
   * Handle all TUS protocol requests
   *
   * The @tus/server handles:
   * - OPTIONS: Return server capabilities (see handleTusOptions — routed separately)
   * - POST: Create new upload
   * - HEAD: Get upload status/offset
   * - PATCH: Continue upload
   * - DELETE: Terminate upload (if termination extension enabled)
   */
  @All()
  @Roles(RoleEnum.S_USER)
  async handleTus(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.tusService.getServer();

    if (!server) {
      this.logger.warn('TUS server not initialized');
      res.status(503).json({ message: 'TUS uploads not available' });
      return;
    }

    try {
      await server.handle(req, res);
    } catch (error) {
      this.logger.error(`TUS request error: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Upload error' });
      }
    }
  }

  /**
   * Handle requests with upload ID parameter
   *
   * Routes like /tus/:id for HEAD, PATCH, DELETE
   */
  @All(':id')
  @Roles(RoleEnum.S_USER)
  async handleTusWithId(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.tusService.getServer();

    if (!server) {
      this.logger.warn('TUS server not initialized');
      res.status(503).json({ message: 'TUS uploads not available' });
      return;
    }

    try {
      await server.handle(req, res);
    } catch (error) {
      this.logger.error(`TUS request error for upload ${req.params.id}: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Upload error' });
      }
    }
  }
}
