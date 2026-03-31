import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { getContextData } from '../helpers/context.helper';
import { getStringIds } from '../helpers/db.helper';
import { processDeep } from '../helpers/input.helper';
import { ConfigService } from '../services/config.service';

/**
 * Verification of all outgoing data via securityCheck
 */
@Injectable()
export class CheckSecurityInterceptor implements NestInterceptor {
  config = {
    debug: false,
    noteCheckedObjects: true,
    removeSecretFields: true,
    secretFields: ['password', 'verificationToken', 'passwordResetToken', 'refreshTokens', 'tempTokens'],
  };

  constructor(private readonly configService: ConfigService) {
    const configuration = this.configService.getFastButReadOnly('security.checkSecurityInterceptor');
    if (typeof configuration === 'object') {
      this.config = { ...this.config, ...configuration };
    }
    // Allow overriding secretFields from security config
    const globalSecretFields = this.configService.getFastButReadOnly('security.secretFields');
    if (Array.isArray(globalSecretFields)) {
      this.config.secretFields = globalSecretFields;
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    // Start time
    const start = Date.now();

    // Get current user
    const user = getContextData(context)?.currentUser || null;

    // Set force mode for sign in and sign up (both GraphQL and REST)
    let force = false;
    if (!user) {
      // Here the name is used and not the class itself, because the concrete class is located in the respective project.
      // In case of an override it is better to use the concrete class directly (context.getClass() instead of context.getClass()?.name).
      const className = context.getClass()?.name;
      if (className === 'AuthResolver' || className === 'AuthController') {
        force = true;
      }
    }

    // Data from next for check
    let objectData: any;

    const check = (data: any) => {
      objectData = data;

      // Check if data already checked
      if (this.config.noteCheckedObjects && data?._objectAlreadyCheckedForRestrictions) {
        return data;
      }

      // Check data
      if (data && typeof data === 'object' && typeof data.securityCheck === 'function') {
        // Only capture pre-check state when debug is active (JSON.stringify is expensive)
        const dataJson = this.config.debug ? JSON.stringify(data) : undefined;
        const response = data.securityCheck(user, force);
        if (this.config.debug && dataJson !== JSON.stringify(response)) {
          const id = getStringIds(data);
          console.debug(
            'CheckSecurityInterceptor: securityCheck changed data of type',
            data.constructor.name,
            id && !Array.isArray(id) ? `with ID: ${id}` : '',
          );
        }
        if (response && !data._doNotCheckSecurityDeep) {
          for (const key of Object.keys(response)) {
            response[key] = check(response[key]);
          }
        }
        return response;
      }

      // Check if data is writeable (e.g. objects from direct access to json files via http are not writable)
      if (data && typeof data === 'object') {
        const writeable = !Object.keys(data).find((key) => !Object.getOwnPropertyDescriptor(data, key).writable);
        if (!writeable) {
          return data;
        }
      }

      // Check deep
      return processDeep(
        data,
        (item) => {
          if (!item || typeof item !== 'object' || typeof item.securityCheck !== 'function') {
            if (Array.isArray(item)) {
              return item.filter((i) => i !== undefined);
            }
            return item;
          }
          return check(item);
        },
        { specialFunctions: ['securityCheck'] },
      );
    };

    // Fallback: Remove known secret fields regardless of model type (recursive into plain objects)
    const isPlainLike = (val: any): boolean => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
      // Skip Streams, Buffers, Dates, RegExps, Maps, Sets
      if (typeof val.pipe === 'function') return false;
      if (Buffer.isBuffer(val)) return false;
      if (val instanceof Date || val instanceof RegExp) return false;
      if (val instanceof Map || val instanceof Set) return false;
      // Skip Mongoose documents and BSON types (they have circular internal references)
      if (val.$__ !== undefined || val._bsontype !== undefined) return false;
      const proto = Object.getPrototypeOf(val);
      // Only recurse into actual plain objects (created via {} or Object.create(null)).
      // Previously used `typeof val.constructor === 'function'` which was too broad and
      // caused infinite recursion on Mongoose Schema.Types.Mixed fields whose internal
      // objects (Schema, SchemaType) have circular references.
      return proto === null || proto === Object.prototype;
    };
    const visited = new WeakSet();
    const removeSecrets = (data: any) => {
      if (!this.config.removeSecretFields || !data || typeof data !== 'object') {
        return data;
      }
      if (Array.isArray(data)) {
        if (visited.has(data)) return data;
        visited.add(data);
        data.forEach(removeSecrets);
        return data;
      }
      if (!isPlainLike(data)) {
        return data;
      }
      // Prevent infinite recursion on circular references
      if (visited.has(data)) {
        return data;
      }
      visited.add(data);
      for (const field of this.config.secretFields) {
        if (field in data && data[field] !== undefined) {
          data[field] = undefined;
        }
      }
      // Recurse into nested plain objects
      for (const key of Object.keys(data)) {
        const value = data[key];
        if (value && typeof value === 'object' && !this.config.secretFields.includes(key)) {
          removeSecrets(value);
        }
      }
      return data;
    };

    // Check response
    const result = next.handle().pipe(map(check), map(removeSecrets));
    if (this.config.debug && Date.now() - start >= (typeof this.config.debug === 'number' ? this.config.debug : 100)) {
      console.warn(
        `Duration for CheckResponseInterceptor is too long: ${Date.now() - start}ms`,
        Array.isArray(objectData)
          ? `${objectData[0].constructor.name}[]: ${objectData.length}`
          : objectData?.constructor?.name,
      );
    }
    return result;
  }
}
