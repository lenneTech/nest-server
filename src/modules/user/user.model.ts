import { IsEmail, IsOptional } from 'class-validator';
import { Field, ObjectType } from 'type-graphql/dist';
import { Column, Entity, Index } from 'typeorm';
import { PersistenceClass } from '../../common/models/persistence.class';

/**
 * User model
 */
@Entity()
@ObjectType({ description: 'User' })
export class User extends PersistenceClass {

  /**
   * E-Mail address of the user
   */
  @Field({ description: 'Email of the user' })
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
   * Username of the user
   */
  @Field({ description: 'Username of the user', nullable: true })
  @IsOptional()
  @Column()
  username?: string;
}
