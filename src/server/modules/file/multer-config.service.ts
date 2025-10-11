import { Injectable } from '@nestjs/common';
import { MulterModuleOptions, MulterOptionsFactory } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

/**
 * Multer configuration service using MemoryStorage
 * Files are stored in memory as Buffer objects and then manually saved to GridFS
 */
@Injectable()
export class GridFsMulterConfigService implements MulterOptionsFactory {
  createMulterOptions(): MulterModuleOptions {
    return {
      storage: memoryStorage(),
    };
  }
}
