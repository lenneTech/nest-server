import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { ConfigService } from '../../../core/common/services/config.service';
import { CoreS3Service } from '../../../core/common/services/core-s3.service';
import { CoreFileService } from '../../../core/modules/file/core-file.service';

/**
 * File service
 */
@Injectable()
export class FileService extends CoreFileService {
  constructor(
    @InjectConnection() protected override readonly connection: Connection,
    protected readonly configService: ConfigService,
    @Optional() protected readonly s3Service?: CoreS3Service,
  ) {
    super(connection, 'fs', { configService, s3Service });
  }

  /**
   * Duplicate file by name
   */
  async duplicate(fileName: string, newName: string): Promise<any> {
    return this.files.openDownloadStreamByName(fileName).pipe(this.files.openUploadStream(newName));
  }

  /**
   * NOTE — where the per-file rule would go.
   *
   * This reference server deliberately does NOT override `checkRights()`. With
   * `file.downloadRoles` at its default `[ADMIN]`, the roles guard answers before
   * the service is reached, so an owner rule here could never fire — and a rule
   * that cannot fire is worse than none, because it reads as protection.
   *
   * The pairing only becomes useful once the coarse gate is widened. A project
   * that wants "signed-in users may fetch THEIR OWN files" sets
   * `file: { downloadRoles: [RoleEnum.S_USER] }` and then overrides:
   *
   * ```typescript
   * protected override async checkRights(input, options) {
   *   if (options?.force || options?.checkInputType !== 'id') {
   *     return true;   // writes and filename reads stay on the role gate
   *   }
   *   if (!options.currentUser) {
   *     return true;   // system-internal call: the guard already decided
   *   }
   *   if (options.currentUser.hasRole?.([RoleEnum.ADMIN])) {
   *     return true;
   *   }
   *   const raw = await this.getRawFileInfo(input);
   *   return !!raw?.metadata?.ownerId && String(raw.metadata.ownerId) === String(options.currentUser.id);
   * }
   * ```
   *
   * `AvatarController` already writes the `metadata.ownerId` such a rule reads,
   * so enabling it in a downstream project is a config change plus this method.
   * See `src/core/modules/file/README.md` § Access control.
   */
}
