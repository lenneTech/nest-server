import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FileInfo, FileInfoSchema } from './file-info.model';
import { FileController } from './file.controller';
import { FileResolver } from './file.resolver';
import { FileService } from './file.service';

/**
 * File module
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: FileInfo.name, schema: FileInfoSchema }])],
  controllers: [FileController],
  providers: [FileService, FileResolver],
  exports: [MongooseModule, FileService],
})
export class FileModule {}
