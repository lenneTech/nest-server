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
}
