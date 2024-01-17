import { GridFsStorage } from '@lenne.tech/multer-gridfs-storage';
import { Injectable } from '@nestjs/common';
import { MulterModuleOptions, MulterOptionsFactory } from '@nestjs/platform-express';

import envConfig from '../../../config.env';

@Injectable()
export class GridFsMulterConfigService implements MulterOptionsFactory {
  gridFsStorage: any;

  constructor() {
    this.gridFsStorage = new GridFsStorage({
      file: (req, file) => {
        return new Promise((resolve) => {
          const filename = file.originalname.trim();
          const fileInfo = {
            filename,
          };
          resolve(fileInfo);
        });
      },
      url: envConfig.mongoose.uri,
    });
  }

  createMulterOptions(): MulterModuleOptions {
    return {
      storage: this.gridFsStorage,
    };
  }
}
