import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { CoreFileService } from '../../../core/modules/file/core-file.service';

/**
 * File service
 */
@Injectable()
export class FileService extends CoreFileService {
  constructor(@InjectConnection() protected readonly connection: Connection) {
    super(connection, 'fs');
  }
}
