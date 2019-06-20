import { IsEmail, IsOptional } from 'class-validator';
import { Field, ObjectType } from 'type-graphql';
import { Column, Index } from 'typeorm';
import { CorePersistenceModel } from '../../common/models/core-persistence.model';

/**
 * User model
 */
@ObjectType({ description: 'User', isAbstract: true })
export abstract class CoreUser extends CorePersistenceModel {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * E-Mail address of the user
   */
  @Field({ description: 'Email of the user', nullable: true })
  @IsEmail()
  @Index({ unique: true })
  @Column()
  email: string;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the user', nullable: true })
  @IsOptional()
  @Column()
  firstName: string;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  @Column()
  lastName: string;

  /**
   * Password of the user
   */
  @Column()
  password: string;

  /**
   * Roles of the user
   */
  @Field(type => [String], { description: 'Roles of the user', nullable: true })
  @IsOptional()
  @Column()
  roles: string[] = [];

  /**
   * Username of the user
   */
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Column()
  username: string;

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
