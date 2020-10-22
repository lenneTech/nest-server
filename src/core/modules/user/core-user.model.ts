import { Entity, Property, Unique } from '@mikro-orm/core';
import { Field, ObjectType } from '@nestjs/graphql';
import { IsEmail, IsOptional } from 'class-validator';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';

/**
 * User model
 */
@ObjectType({ description: 'User', isAbstract: true })
@Entity()
export abstract class CoreUserModel extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  @Field({ description: 'Email of the user', nullable: true })
  @IsEmail()
  @Property()
  @Unique()
  email: string = undefined;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  @Property()
  firstName: string = undefined;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  @Property()
  lastName: string = undefined;

  /**
   * Password of the user
   */
  @Property()
  password: string = undefined;

  /**
   * Roles of the user
   */
  @Field((type) => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  @Property()
  roles: string[] = [];

  /**
   * Username of the user
   */
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Property()
  username: string = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Checks whether the user has at least one of the required roles
   */
  public hasRole(roles: string | string[]) {
    if (typeof roles === 'string') {
      roles = [roles];
    }
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles || roles.length < 1 ? true : this.roles.some((role) => roles.includes(role));
  }

  /**
   * Checks whether the user has all required roles
   */
  public hasAllRoles(roles: string | string[]) {
    if (typeof roles === 'string') {
      roles = [roles];
    }
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles ? true : roles.every((role) => this.roles.includes(role));
  }
}
