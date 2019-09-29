import { Field, ObjectType } from 'type-graphql';
import { Column, Entity } from 'typeorm';
import { CoreUserModel } from '../../../core/modules/user/core-user.model';
import { Editor } from '../../common/models/editor.model';
import { PersistenceModel } from '../../common/models/persistence.model';

/**
 * User model
 */
@Entity()
@ObjectType({ description: 'User' })
export class User extends CoreUserModel implements PersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * URL to avatar file of the user
   */
  @Field({ description: 'URL to avatar file of the user', nullable: true })
  @Column()
  avatar: string;

  /**
   * Editor who created the object
   *
   * Not set when created by system
   */
  @Field((type) => Editor, {
    description: 'ID of the user who created the object',
    nullable: true
  })
  @Column('varchar')
  createdBy: string | Editor;

  /**
   * Editor who last updated the object
   *
   * Not set when updated by system
   */
  @Field((type) => Editor, {
    description: 'ID of the user who last updated the object',
    nullable: true
  })
  @Column('varchar')
  updatedBy: string | Editor;
}
