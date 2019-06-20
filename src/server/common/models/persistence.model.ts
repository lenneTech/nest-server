import { Field, ObjectType } from 'type-graphql';
import { Column } from 'typeorm';
import { JoinColumn } from 'typeorm/decorator/relations/JoinColumn';
import { OneToOne } from 'typeorm/decorator/relations/OneToOne';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model';
import { User } from '../../modules/user/user.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of TypeORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
export class PersistenceModel extends CorePersistenceModel {

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  @Field(type => User, { description: 'User who created the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  createdBy?: User;

  /**
   * Labels of the object
   */
  @Field(type => [String], { description: 'Labels of the object', nullable: true })
  @Column()
  labels: string[] = [];

  /**
   * Tags for the object
   */
  @Field(type => [String], { description: 'Tags for the object', nullable: true })
  @Column()
  tags: string[] = [];

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  @Field(type => User, { description: 'User who last updated the object', nullable: true })
  @OneToOne(type => User)
  @JoinColumn()
  updatedBy?: User;
}
