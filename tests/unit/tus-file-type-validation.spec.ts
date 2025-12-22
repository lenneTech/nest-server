/**
 * Unit tests for TUS file type validation
 *
 * Tests the validateFileType logic used in CoreTusService
 */
import { describe, expect, it } from 'vitest';

/**
 * Standalone implementation of the validateFileType logic for testing
 * This mirrors the logic in CoreTusService.validateFileType
 */
function validateFileType(filetype: string | undefined, allowedTypes: string[] | undefined): boolean {
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

describe('TUS File Type Validation', () => {
  describe('validateFileType', () => {
    describe('when no restrictions configured', () => {
      it('should allow any file type when allowedTypes is undefined', () => {
        expect(validateFileType('image/jpeg', undefined)).toBe(true);
        expect(validateFileType('application/pdf', undefined)).toBe(true);
        expect(validateFileType('text/plain', undefined)).toBe(true);
      });

      it('should allow any file type when allowedTypes is empty array', () => {
        expect(validateFileType('image/jpeg', [])).toBe(true);
        expect(validateFileType('application/pdf', [])).toBe(true);
      });

      it('should allow undefined filetype when no restrictions', () => {
        expect(validateFileType(undefined, undefined)).toBe(true);
        expect(validateFileType(undefined, [])).toBe(true);
      });
    });

    describe('when restrictions are configured', () => {
      it('should allow exact match file types', () => {
        const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];

        expect(validateFileType('image/jpeg', allowedTypes)).toBe(true);
        expect(validateFileType('image/png', allowedTypes)).toBe(true);
        expect(validateFileType('application/pdf', allowedTypes)).toBe(true);
      });

      it('should reject non-matching file types', () => {
        const allowedTypes = ['image/jpeg', 'image/png'];

        expect(validateFileType('image/gif', allowedTypes)).toBe(false);
        expect(validateFileType('application/pdf', allowedTypes)).toBe(false);
        expect(validateFileType('text/plain', allowedTypes)).toBe(false);
      });

      it('should reject undefined filetype when restrictions exist', () => {
        const allowedTypes = ['image/jpeg', 'image/png'];

        expect(validateFileType(undefined, allowedTypes)).toBe(false);
      });

      it('should reject empty string filetype when restrictions exist', () => {
        const allowedTypes = ['image/jpeg', 'image/png'];

        expect(validateFileType('', allowedTypes)).toBe(false);
      });
    });

    describe('wildcard patterns', () => {
      it('should allow all images with image/* wildcard', () => {
        const allowedTypes = ['image/*'];

        expect(validateFileType('image/jpeg', allowedTypes)).toBe(true);
        expect(validateFileType('image/png', allowedTypes)).toBe(true);
        expect(validateFileType('image/gif', allowedTypes)).toBe(true);
        expect(validateFileType('image/webp', allowedTypes)).toBe(true);
        expect(validateFileType('image/svg+xml', allowedTypes)).toBe(true);
      });

      it('should reject non-image types with image/* wildcard', () => {
        const allowedTypes = ['image/*'];

        expect(validateFileType('application/pdf', allowedTypes)).toBe(false);
        expect(validateFileType('text/plain', allowedTypes)).toBe(false);
        expect(validateFileType('video/mp4', allowedTypes)).toBe(false);
      });

      it('should allow all videos with video/* wildcard', () => {
        const allowedTypes = ['video/*'];

        expect(validateFileType('video/mp4', allowedTypes)).toBe(true);
        expect(validateFileType('video/webm', allowedTypes)).toBe(true);
        expect(validateFileType('video/quicktime', allowedTypes)).toBe(true);
      });

      it('should allow all text types with text/* wildcard', () => {
        const allowedTypes = ['text/*'];

        expect(validateFileType('text/plain', allowedTypes)).toBe(true);
        expect(validateFileType('text/html', allowedTypes)).toBe(true);
        expect(validateFileType('text/css', allowedTypes)).toBe(true);
        expect(validateFileType('text/javascript', allowedTypes)).toBe(true);
      });

      it('should support mixed exact and wildcard patterns', () => {
        const allowedTypes = ['image/*', 'application/pdf', 'text/plain'];

        // Wildcard matches
        expect(validateFileType('image/jpeg', allowedTypes)).toBe(true);
        expect(validateFileType('image/png', allowedTypes)).toBe(true);

        // Exact matches
        expect(validateFileType('application/pdf', allowedTypes)).toBe(true);
        expect(validateFileType('text/plain', allowedTypes)).toBe(true);

        // Not allowed
        expect(validateFileType('video/mp4', allowedTypes)).toBe(false);
        expect(validateFileType('application/json', allowedTypes)).toBe(false);
        expect(validateFileType('text/html', allowedTypes)).toBe(false); // Only text/plain is allowed, not text/*
      });

      it('should support application/* wildcard', () => {
        const allowedTypes = ['application/*'];

        expect(validateFileType('application/pdf', allowedTypes)).toBe(true);
        expect(validateFileType('application/json', allowedTypes)).toBe(true);
        expect(validateFileType('application/octet-stream', allowedTypes)).toBe(true);
        expect(validateFileType('application/zip', allowedTypes)).toBe(true);

        expect(validateFileType('image/png', allowedTypes)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle case-sensitive comparison', () => {
        const allowedTypes = ['image/jpeg'];

        expect(validateFileType('image/jpeg', allowedTypes)).toBe(true);
        expect(validateFileType('image/JPEG', allowedTypes)).toBe(false);
        expect(validateFileType('IMAGE/jpeg', allowedTypes)).toBe(false);
      });

      it('should handle file types with special characters', () => {
        const allowedTypes = ['image/svg+xml', 'application/vnd.ms-excel'];

        expect(validateFileType('image/svg+xml', allowedTypes)).toBe(true);
        expect(validateFileType('application/vnd.ms-excel', allowedTypes)).toBe(true);
      });

      it('should handle single allowed type', () => {
        const allowedTypes = ['application/pdf'];

        expect(validateFileType('application/pdf', allowedTypes)).toBe(true);
        expect(validateFileType('image/jpeg', allowedTypes)).toBe(false);
      });
    });
  });
});
