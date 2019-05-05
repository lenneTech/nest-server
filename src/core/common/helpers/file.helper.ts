import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { extname } from 'path';

/**
 * Helper class for inputs
 */
export class FileHelper {

  /**
   * Get function to generate a random file name for multer with a certain
   * number of digits
   */
  public static multerRandomFileName(numberOfDigits = 32) {
    return (req, file, cb) => {

      // Generating a random string
      const randomName = Array(numberOfDigits).fill(null).map(
        () => (Math.round(Math.random() * 16)).toString(16),
      ).join('');

      // Calling the callback passing the random name generated with the
      // original extension name
      cb(null, `${randomName}${extname(file.originalname)}`);
    };
  }

  /**
   * Get function to filter files for multer with a certain mimetype & extname
   */
  public static multerFileFilter(fileTypeRegex: RegExp = /jpeg|jpg|png/) {
    return (req, file, cb) => {

      const mimetype = fileTypeRegex.test(file.mimetype);
      const extName = fileTypeRegex.test(extname(file.originalname).toLowerCase());

      if (mimetype && extName) {
        return cb(null, true);
      }
      cb('Error: File upload only supports the following filetypes - ' + fileTypeRegex);
    };
  }

  /**
   * Get multer options for image upload
   */
  public static multerOptionsForImageUpload(options: {
    destination?: string,
    fileSize?: number,
    fileTypeRegex?: RegExp,
  }): MulterOptions {

    // Default options
    options = Object.assign({
      fileSize: 1024 * 1024, // 1MB
      fileTypeRegex: /jpeg|jpg|png/, // Images only
    }, options);

    return {

      // File filter
      fileFilter: options.fileTypeRegex ?
        FileHelper.multerFileFilter(options.fileTypeRegex) : undefined,

      // Limits
      limits: {

        // Limit of file size
        fileSize: options.fileSize ? options.fileSize : undefined,
      },

      // Automatic storage handling
      // For configuration see https://github.com/expressjs/multer#storage
      storage: diskStorage({

        // Destination for uploaded file
        // If destination is not set file will be buffered and can be processed
        // in the method
        destination: options.destination ? options.destination : undefined,

        // Generated random file name
        filename: FileHelper.multerRandomFileName(),
      }),
    };
  }
}
