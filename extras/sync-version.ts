import { execFileSync } from 'child_process';
import * as find from 'find-file-up';
import * as fs from 'fs';

/**
 * Update data class
 *
 * Stages the pnpm-lock.yaml file if it exists, so that the lock file
 * is always committed alongside package.json version changes.
 */
class UpdateData {
  /**
   * Get file path
   */
  public async getFilePath(fileName: string, options: { cwd?: string } = {}): Promise<string> {
    const opts = Object.assign({ cwd: process.cwd() }, options);
    const path = await find(fileName, opts.cwd);
    return path || '';
  }

  /**
   * Runner
   */
  async run() {
    // Get current version from package.json
    const packageJsonPath = await this.getFilePath('package.json');
    if (!packageJsonPath) {
      throw new Error('Missing package.json');
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;
    if (!version) {
      throw new Error('Missing version in package.json');
    }

    // Stage pnpm-lock.yaml if it exists. No shell: the absolute path may contain spaces
    // (e.g. C:\Users\First Last\...), which an interpolated command string would split.
    const lockFilePath = await this.getFilePath('pnpm-lock.yaml');
    if (lockFilePath && fs.existsSync(lockFilePath)) {
      execFileSync('git', ['add', lockFilePath]);
    }

    // Return version
    return version;
  }
}

// Update version
new UpdateData().run().then((version) => {
  // console.info, not console.log: lint-staged runs `oxlint --fix --fix-suggestions`, whose
  // no-console suggestion deletes a console.log from any staged file
  console.info(version);
});
