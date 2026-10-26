import { forwardRef, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { UserModule } from '../user/user.module.js';
import { FileController } from './file.controller.js';
import { FileResolver } from './file.resolver.js';
import { FileService } from './file.service.js';
import { GridFsMulterConfigService } from './multer-config.service.js';

/**
 * File module
 */
@Module({
  controllers: [FileController],
  exports: [FileService],
  imports: [
    MulterModule.registerAsync({
      useClass: GridFsMulterConfigService,
    } as any),
    forwardRef(() => UserModule),
  ],
  providers: [GridFsMulterConfigService, FileService, FileResolver],
})
export class FileModule {}
