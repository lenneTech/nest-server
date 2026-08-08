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
}
