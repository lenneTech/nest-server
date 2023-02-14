import { forwardRef, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { UserModule } from '../user/user.module';
import { FileController } from './file.controller';
import { FileResolver } from './file.resolver';
import { FileService } from './file.service';
import { GridFsMulterConfigService } from './multer-config.service';

/**
 * File module
 */
@Module({
  imports: [
    MulterModule.registerAsync({
      useClass: GridFsMulterConfigService,
    } as any),
    forwardRef(() => UserModule),
  ],
  controllers: [FileController],
  providers: [GridFsMulterConfigService, FileService, FileResolver],
  exports: [FileService],
})
export class FileModule {}
