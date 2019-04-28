import { IsEmail, IsOptional } from 'class-validator';
import { Field, ID } from 'type-graphql';
import { ObjectType } from 'type-graphql/dist/decorators/ObjectType';
import { BeforeInsert, BeforeUpdate, Column, Index, JoinColumn, ObjectIdColumn, OneToOne } from 'typeorm';
import { Restricted, RoleEnum } from '../../..';
import { IAuthUser } from '../auth/interfaces/auth-user.interface';

/**
 * User model
 */
@ObjectType({ description: 'Core user', isAbstract: true })
export class User {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * ID of the persistence object
   */
  @Field(type => ID, { description: 'ID of the persistence object', nullable: true })
  @ObjectIdColumn()
  id: string;

  /**
   * Created date
   */
  @Field({ description: 'Created date', nullable: true })
  @Column()
  createdAt: Date;

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, { description: 'User who created the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  createdBy?: IAuthUser;

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
  firstName?: string;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the user', nullable: true })
  @IsOptional()
  @Column()
  lastName?: string;

  /**
   * IDs of the Owners
   */
  @Restricted(RoleEnum.ADMIN, RoleEnum.OWNER)
  @Field(type => [String], { description: 'Users who own the object', nullable: true })
  @Column()
  ownerIds: string[] = [];

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
   * Updated date
   */
  @Field({ description: 'Updated date', nullable: true })
  @Column()
  updatedAt: Date;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, { description: 'User who last updated the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  updatedBy?: IAuthUser;

  /**
   * Username of the user
   */
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Column()
  username?: string;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Manipulation before insert a new entity
   * https://typeorm.io/#/listeners-and-subscribers
   */
  @BeforeInsert()
  beforeInsert() {
    this.createdAt = this.updatedAt = new Date();
  }

  /**
   * Manipulation before update an existing entity
   * https://typeorm.io/#/listeners-and-subscribers
   */
  @BeforeUpdate()
  beforeUpdate() {
    this.updatedAt = new Date();
  }

  /**
   * Checks whether the user has at least one of the required roles
   */
  public hasRole(roles: string[]): boolean {
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles || roles.length < 1 ? true : this.roles.some((role) => roles.includes(role));
  }

  /**
   * Checks whether the user has all required roles
   */
  public hasAllRoles(roles: string[]): boolean {
    if (!this.roles || this.roles.length < 1) {
      return false;
    }
    return !roles ? true : roles.every((role) => this.roles.includes(role));
  }

}
