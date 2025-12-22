import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FileStore } from '@tus/file-store';
import { Server, Upload } from '@tus/server';
import * as fs from 'fs';
import { Connection, mongo } from 'mongoose';
import * as path from 'path';

import { GridFSHelper } from '../../common/helpers/gridfs.helper';
import { ITusConfig } from '../../common/interfaces/server-options.interface';
import {
  DEFAULT_TUS_ALLOWED_HEADERS,
  DEFAULT_TUS_CONFIG,
  normalizeTusConfig,
  parseExpirationTime,
} from './interfaces/tus-config.interface';

/**
 * Core TUS Service
 *
 * Provides integration with @tus/server for resumable file uploads.
 * After upload completion, files are migrated to GridFS and a File entity is created.
 *
 * This service follows the Module Inheritance Pattern and can be extended in projects.
 */
@Injectable()
export class CoreTusService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(CoreTusService.name);
  private tusServer: null | Server = null;
  private config: ITusConfig;
  private files: mongo.GridFSBucket;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly connection: Connection) {
    // Initialize with defaults - will be configured in onModuleInit or via configure()
    this.config = { ...DEFAULT_TUS_CONFIG };
  }

  /**
   * Configure the TUS service
   * Called by TusModule.forRoot() with the resolved configuration
   */
  configure(config: boolean | ITusConfig | undefined): void {
    const normalizedConfig = normalizeTusConfig(config);
    if (normalizedConfig) {
      this.config = normalizedConfig;
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('TUS uploads disabled');
      return;
    }

    // Initialize GridFS bucket
    this.files = new mongo.GridFSBucket(this.connection.db, { bucketName: 'fs' });

    // Ensure upload directory exists
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    await this.ensureUploadDir(uploadDir);

    // Create TUS server instance
    this.tusServer = this.createTusServer(uploadDir);

    // Setup expiration cleanup if enabled
    this.setupExpirationCleanup();

    this.logger.log(`TUS server initialized at ${this.config.path}`);
    this.logEnabledFeatures();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get the TUS server instance
   */
  getServer(): null | Server {
    return this.tusServer;
  }

  /**
   * Get the current configuration
   */
  getConfig(): ITusConfig {
    return this.config;
  }

  /**
   * Check if TUS is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled !== false && this.tusServer !== null;
  }

  /**
   * Get the configured path
   */
  getPath(): string {
    return this.config.path || DEFAULT_TUS_CONFIG.path;
  }

  /**
   * Handle upload completion - migrate to GridFS
   *
   * This method can be overridden in extending services to customize
   * what happens after an upload completes.
   */
  protected async onUploadComplete(upload: Upload): Promise<void> {
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const filePath = path.join(uploadDir, upload.id);

    try {
      // Extract metadata
      const metadata = this.parseMetadata(upload.metadata);
      const filename = metadata.filename || upload.id;
      const contentType = metadata.filetype || 'application/octet-stream';

      // Check if file exists
      const fileExists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        this.logger.warn(`Upload file not found at ${filePath}, skipping GridFS migration`);
        return;
      }

      // Read the completed file and upload to GridFS
      const readStream = fs.createReadStream(filePath);
      const fileInfo = await GridFSHelper.writeFileFromStream(this.files, readStream, {
        contentType,
        filename,
        metadata: {
          originalMetadata: metadata,
          tusUploadId: upload.id,
          uploadedAt: new Date(),
        },
      });

      this.logger.debug(`Upload ${upload.id} migrated to GridFS as ${fileInfo._id} (filename: ${filename})`);

      // Clean up the temporary file
      await this.deleteTemporaryFile(upload.id);
    } catch (error) {
      this.logger.error(`Failed to migrate upload ${upload.id} to GridFS: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle upload termination (deletion)
   */
  protected async onUploadTerminate(upload: Upload): Promise<void> {
    this.logger.debug(`Upload ${upload.id} terminated`);
    await this.deleteTemporaryFile(upload.id);
  }

  /**
   * Validate file type against allowedTypes configuration
   *
   * This method can be overridden in extending services to customize
   * file type validation logic.
   *
   * @param filetype - The MIME type from upload metadata
   * @returns true if allowed, false if rejected
   */
  protected validateFileType(filetype: string | undefined): boolean {
    const allowedTypes = this.config.allowedTypes;

    // If no restrictions configured, allow all types
    if (!allowedTypes || allowedTypes.length === 0) {
      return true;
    }

    // If no filetype provided in metadata, reject when restrictions exist
    if (!filetype) {
      return false;
    }

    // Check exact match
    if (allowedTypes.includes(filetype)) {
      return true;
    }

    // Check wildcard patterns (e.g., 'image/*')
    for (const allowed of allowedTypes) {
      if (allowed.endsWith('/*')) {
        const prefix = allowed.slice(0, -1); // 'image/*' -> 'image/'
        if (filetype.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Create the TUS server instance with configured extensions
   */
  private createTusServer(uploadDir: string): Server {
    const datastore = new FileStore({ directory: uploadDir });

    const server = new Server({
      allowedHeaders: this.config.allowedHeaders || DEFAULT_TUS_ALLOWED_HEADERS,
      datastore,
      maxSize: this.config.maxSize,
      onUploadCreate: async (_req, upload) => {
        // Validate file type if allowedTypes is configured
        if (this.config.allowedTypes && this.config.allowedTypes.length > 0) {
          const metadata = this.parseMetadata(upload.metadata);
          const filetype = metadata.filetype;

          if (!this.validateFileType(filetype)) {
            const allowedList = this.config.allowedTypes.join(', ');
            this.logger.warn(
              `Upload rejected: file type '${filetype || 'unknown'}' not allowed. Allowed types: ${allowedList}`,
            );

            // Throw error to reject the upload
            // @tus/server v2 expects throwing an error with status_code
            const error = new Error(
              `File type '${filetype || 'unknown'}' is not allowed. Allowed types: ${allowedList}`,
            );
            (error as any).status_code = 415; // Unsupported Media Type
            throw error;
          }
        }

        // Return empty object to proceed with upload
        return {};
      },
      onUploadFinish: async (_req, upload) => {
        try {
          await this.onUploadComplete(upload);
          return {};
        } catch (error) {
          this.logger.error(`Upload finish error: ${error.message}`);
          return {};
        }
      },
      path: this.config.path || DEFAULT_TUS_CONFIG.path,
      respectForwardedHeaders: true,
    });

    return server;
  }

  /**
   * Parse TUS metadata into object
   * @tus/server v2 already parses metadata into an object
   */
  private parseMetadata(metadata: Record<string, string> | string | undefined): Record<string, string> {
    if (!metadata) {
      return {};
    }

    // @tus/server v2 returns metadata as an object
    if (typeof metadata === 'object') {
      return metadata;
    }

    // Fallback for string format (legacy or raw)
    const result: Record<string, string> = {};
    const pairs = metadata.split(',');

    for (const pair of pairs) {
      const [key, value] = pair.trim().split(' ');
      if (key) {
        // Decode base64 value if present
        result[key] = value ? Buffer.from(value, 'base64').toString('utf-8') : '';
      }
    }

    return result;
  }

  /**
   * Ensure the upload directory exists
   */
  private async ensureUploadDir(uploadDir: string): Promise<void> {
    try {
      await fs.promises.mkdir(uploadDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * Delete a temporary upload file
   */
  private async deleteTemporaryFile(uploadId: string): Promise<void> {
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const filePath = path.join(uploadDir, uploadId);
    const infoPath = `${filePath}.json`;

    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }

    try {
      await fs.promises.unlink(infoPath);
    } catch {
      // Ignore if info file doesn't exist
    }
  }

  /**
   * Setup periodic cleanup of expired uploads
   */
  private setupExpirationCleanup(): void {
    const expirationConfig = this.config.expiration;
    // Handle boolean | ITusExpirationConfig type
    if (!expirationConfig) {
      return;
    }

    let expiresIn = '24h';

    // If explicitly set to false, skip
    if (typeof expirationConfig === 'boolean') {
      if (!expirationConfig) {
        return;
      }
      // If true, use defaults (expiresIn already set to '24h')
    } else {
      // ITusExpirationConfig object
      if (expirationConfig.enabled === false) {
        return;
      }
      expiresIn = expirationConfig.expiresIn || '24h';
    }

    const expirationMs = parseExpirationTime(expiresIn);

    // Run cleanup every hour
    this.cleanupInterval = setInterval(
      async () => {
        await this.cleanupExpiredUploads(expirationMs);
      },
      60 * 60 * 1000,
    );

    this.logger.debug(`Expiration cleanup scheduled (expire after ${expiresIn})`);
  }

  /**
   * Clean up expired incomplete uploads
   */
  private async cleanupExpiredUploads(maxAgeMs: number): Promise<void> {
    const uploadDir = this.config.uploadDir || DEFAULT_TUS_CONFIG.uploadDir;
    const now = Date.now();

    try {
      const files = await fs.promises.readdir(uploadDir);
      let cleanedCount = 0;

      for (const file of files) {
        if (file.endsWith('.json')) {
          continue; // Skip info files
        }

        const filePath = path.join(uploadDir, file);
        const stats = await fs.promises.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await this.deleteTemporaryFile(file);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.debug(`Cleaned up ${cleanedCount} expired uploads`);
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup expired uploads: ${error.message}`);
    }
  }

  /**
   * Log which features are enabled
   */
  private logEnabledFeatures(): void {
    const features: string[] = [];

    if (this.config.creation !== false) {
      features.push('creation');
    }
    if (this.config.creationWithUpload !== false) {
      features.push('creation-with-upload');
    }
    if (this.config.termination !== false) {
      features.push('termination');
    }
    if (this.config.expiration !== false) {
      features.push('expiration');
    }
    if (this.config.checksum !== false) {
      features.push('checksum');
    }
    if (this.config.concatenation !== false) {
      features.push('concatenation');
    }

    if (features.length > 0) {
      this.logger.log(`TUS extensions: ${features.join(', ')}`);
    }

    // Log file type restrictions if configured
    if (this.config.allowedTypes && this.config.allowedTypes.length > 0) {
      this.logger.log(`TUS allowed types: ${this.config.allowedTypes.join(', ')}`);
    }
  }
}
