import { execSync } from 'child_process';
import * as find from 'find-file-up';
import * as fs from 'fs';

/**
 * Update data class
 */
class UpdateData {
  /**
   * Get file
   */
  public async getFile(
    fileName: string,
    options: { cwd?: string } = {},
  ): Promise<{ path: string; data: any }> {
    // Prepare options
    const opts = Object.assign(
      {
        cwd: process.cwd(),
      },
      options,
    );

    // Find package.json
    const path = await find(fileName, opts.cwd);
    if (!path) {
      return { path: '', data: null };
    }

    // Everything ok
    return { path, data: await this.readFile(path) };
  }

  /**
   * Read a file
   */
  public readFile(path: string) {
    return new Promise((resolve, reject) => {
      fs.readFile(path, (err, data) => {
        if (err) {
          reject(err);
        } else {
          if (path.endsWith('.json')) {
            resolve(JSON.parse(data.toString()));
          } else {
            resolve(data);
          }
        }
      });
    });
  }

  /**
   * Set data in file
   */
  public async setFile(
    fileName: string,
    data: string | { [key: string]: any },
    options: {
      cwd?: string;
    } = {},
  ) {
    if (typeof data === 'object') {
      data = JSON.stringify(data, null, 2);
    }

    // Path to package.json
    const { path } = await this.getFile(fileName, options);
    if (!path) {
      return;
    }

    // Write
    try {
      fs.unlinkSync(path);
      fs.writeFileSync(path, data);
    } catch (e) {
      return '';
    }

    // Done
    return;
  }

  /**
   * Runner
   */
  async run() {
    // File to sync
    const fileName = 'package-lock.json';

    // Get current version
    const {
      data: { version },
    } = await this.getFile('package.json');
    if (!version) {
      throw new Error('Missing version');
    }

    // Get data
    const { data, path } = await this.getFile(fileName);
    if (!path) {
      throw new Error(`Missing ${fileName}`);
    }

    // Compare and update
    if (data.version !== version) {
      data.version = version;
      await this.setFile(fileName, data);
      execSync(`git add ${path}`);
    }

    // Return version
    return version;
  }
}

// Update version
new UpdateData().run().then(version => {
  console.log(version);
});
