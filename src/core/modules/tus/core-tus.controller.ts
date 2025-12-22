import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreTusService } from './core-tus.service';

/**
 * Core TUS Controller
 *
 * Handles all TUS protocol requests and delegates to the @tus/server handler.
 * This controller uses S_EVERYONE by default, allowing all users to upload.
 *
 * Projects can extend this controller to add authentication/authorization:
 *
 * @example
 * ```typescript
 * @Controller('tus')
 * @Roles(RoleEnum.S_USER) // Require authentication
 * export class TusController extends CoreTusController {
 *   // Customize as needed
 * }
 * ```
 */
@Controller('tus')
@Roles(RoleEnum.S_EVERYONE)
export class CoreTusController {
  private readonly logger = new Logger(CoreTusController.name);

  constructor(protected readonly tusService: CoreTusService) {}

  /**
   * Handle all TUS protocol requests
   *
   * The @tus/server handles:
   * - OPTIONS: Return server capabilities
   * - POST: Create new upload
   * - HEAD: Get upload status/offset
   * - PATCH: Continue upload
   * - DELETE: Terminate upload (if termination extension enabled)
   */
  @All()
  @Roles(RoleEnum.S_EVERYONE)
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
  @Roles(RoleEnum.S_EVERYONE)
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
