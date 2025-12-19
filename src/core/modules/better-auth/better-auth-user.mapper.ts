import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { RoleEnum } from '../../common/enums/role.enum';

/**
 * Interface for Better-Auth session user
 */
export interface BetterAuthSessionUser {
  createdAt?: Date;
  email: string;
  emailVerified?: boolean;
  id: string;
  image?: string;
  name?: string;
  updatedAt?: Date;
}

/**
 * Interface for mapped user with role capabilities
 */
export interface MappedUser {
  /**
   * Marker to identify Better-Auth authenticated users
   * Used by AuthGuard to skip Passport authentication for these users
   */
  _authenticatedViaBetterAuth: true;
  email: string;
  emailVerified?: boolean;
  hasRole: (roles: string | string[]) => boolean;
  iamId: string;
  id: string;
  image?: string;
  name?: string;
  roles: string[];
  /**
   * Whether the user is verified (from our database)
   * Used for S_VERIFIED role check
   */
  verified?: boolean;
}

/**
 * Interface for synced user document returned from database
 */
export interface SyncedUserDocument {
  _id: any;
  avatar?: string;
  createdAt: Date;
  email: string;
  firstName?: string;
  iamId: string;
  lastName?: string;
  password?: string;
  roles: string[];
  updatedAt: Date;
  verified?: boolean;
}

/**
 * Service to map Better-Auth users to the application's User model
 *
 * This service bridges the gap between Better-Auth's session-based users
 * and the application's role-based security system.
 */
@Injectable()
export class BetterAuthUserMapper {
  private readonly logger = new Logger(BetterAuthUserMapper.name);

  constructor(@Optional() @InjectConnection() private readonly connection?: Connection) {}

  /**
   * Maps a Better-Auth session user to a user with role capabilities
   *
   * This method:
   * 1. Looks up the user in the application's user collection by email
   * 2. If found, returns the full user with roles and hasRole() method
   * 3. If not found, returns a minimal user with default roles
   *
   * @param sessionUser - The Better-Auth session user
   * @returns A mapped user with role capabilities
   */
  async mapSessionUser(sessionUser: BetterAuthSessionUser): Promise<MappedUser | null> {
    if (!sessionUser?.id || !sessionUser?.email) {
      return null;
    }

    // If no database connection, return user with default roles
    if (!this.connection) {
      this.logger.warn('No database connection available - using default role mapping');
      return this.createMappedUser({
        email: sessionUser.email,
        emailVerified: sessionUser.emailVerified,
        iamId: sessionUser.id,
        id: sessionUser.id,
        image: sessionUser.image,
        name: sessionUser.name,
        roles: [RoleEnum.S_USER],
        verified: sessionUser.emailVerified, // Use Better-Auth emailVerified status
      });
    }

    try {
      // Look up the user in our database by email OR iamId
      // This ensures we find the user regardless of which system they signed up with
      const userCollection = this.connection.collection('users');
      const dbUser = await userCollection.findOne({
        $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
      });

      if (dbUser) {
        // User exists in our database - use their roles and verified status
        const roles = Array.isArray(dbUser.roles) ? dbUser.roles : [];
        // Use database verified status, fallback to Better-Auth emailVerified
        const verified = dbUser.verified === true || sessionUser.emailVerified === true;

        return this.createMappedUser({
          email: sessionUser.email,
          emailVerified: sessionUser.emailVerified,
          iamId: sessionUser.id,
          id: dbUser._id.toString(),
          image: sessionUser.image,
          name: sessionUser.name,
          roles,
          verified,
        });
      }

      // User doesn't exist in our database yet
      // This can happen if they signed up through Better-Auth but not legacy auth
      // Return a user with default roles (S_USER since they're authenticated)
      this.logger.debug(`Better-Auth user ${sessionUser.email} not found in users collection`);

      return this.createMappedUser({
        email: sessionUser.email,
        emailVerified: sessionUser.emailVerified,
        iamId: sessionUser.id,
        id: sessionUser.id, // Use Better-Auth ID as fallback
        image: sessionUser.image,
        name: sessionUser.name,
        roles: [RoleEnum.S_USER], // Default role for authenticated users
        verified: sessionUser.emailVerified, // Use Better-Auth emailVerified status
      });
    } catch (error) {
      this.logger.error(`Error mapping Better-Auth user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  /**
   * Creates a mapped user object with the hasRole method
   */
  private createMappedUser(userData: Omit<MappedUser, '_authenticatedViaBetterAuth' | 'hasRole'>): MappedUser {
    const roles = userData.roles || [];

    return {
      ...userData,
      _authenticatedViaBetterAuth: true,
      hasRole: (checkRoles: string | string[]): boolean => {
        const rolesToCheck = Array.isArray(checkRoles) ? checkRoles : [checkRoles];

        // Check for special roles
        if (rolesToCheck.includes(RoleEnum.S_EVERYONE)) {
          return true;
        }

        if (rolesToCheck.includes(RoleEnum.S_USER)) {
          return true; // User is authenticated via Better-Auth
        }

        if (rolesToCheck.includes(RoleEnum.S_NO_ONE)) {
          return false;
        }

        // S_VERIFIED check - uses verified field (from DB or Better-Auth emailVerified)
        if (rolesToCheck.includes(RoleEnum.S_VERIFIED)) {
          return userData.verified === true;
        }

        // Check actual roles
        return rolesToCheck.some((role) => roles.includes(role));
      },
      roles,
    };
  }

  /**
   * Links an existing user or creates a new user from Better-Auth session data
   *
   * This method:
   * 1. Searches by email OR iamId (supports both login paths)
   * 2. Creates new user if not found (with default S_USER role)
   * 3. Links existing user by setting iamId
   *
   * NOTE: No password handling is needed because both Legacy Auth and Better-Auth
   * use bcrypt-compatible password hashing. Users can authenticate with either system.
   *
   * @param sessionUser - The Better-Auth session user
   * @param additionalData - Additional data to set on the user
   * @returns The linked/created user document or null on error
   */
  async linkOrCreateUser(
    sessionUser: BetterAuthSessionUser,
    additionalData?: Record<string, any>,
  ): Promise<null | SyncedUserDocument> {
    if (!sessionUser?.email) {
      return null;
    }

    // Cannot sync without database connection
    if (!this.connection) {
      this.logger.warn('No database connection available - cannot sync user');
      return null;
    }

    try {
      const userCollection = this.connection.collection('users');

      // Check if user already exists
      const existingUser = await userCollection.findOne({
        $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
      });

      const updateData: Record<string, any> = {
        email: sessionUser.email,
        ...(sessionUser.name && { firstName: sessionUser.name.split(' ')[0] }),
        ...(sessionUser.name &&
          sessionUser.name.includes(' ') && {
            lastName: sessionUser.name.split(' ').slice(1).join(' '),
          }),
        ...(sessionUser.emailVerified !== undefined && { verified: sessionUser.emailVerified }),
        ...(sessionUser.image && { avatar: sessionUser.image }),
        iamId: sessionUser.id,
        updatedAt: new Date(),
        ...additionalData,
      };

      // Build the update query
      const updateQuery: Record<string, any> = {
        $set: updateData,
      };

      // Only set defaults on insert (new user)
      if (!existingUser) {
        updateQuery.$setOnInsert = {
          createdAt: new Date(),
          roles: [RoleEnum.S_USER],
        };
      }

      const result = await userCollection.findOneAndUpdate(
        {
          $or: [{ email: sessionUser.email }, { iamId: sessionUser.id }],
        },
        updateQuery,
        {
          returnDocument: 'after',
          upsert: true,
        },
      );

      return result as null | SyncedUserDocument;
    } catch (error) {
      this.logger.error(`Error syncing Better-Auth user: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }
}
