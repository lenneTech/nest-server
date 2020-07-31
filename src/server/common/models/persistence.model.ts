import { Field, ObjectType } from '@nestjs/graphql';
import { Column } from 'typeorm';
import { CorePersistenceModel } from '../../../core/common/models/core-persistence.model';
import { Editor } from './editor.model';

/**
 * Metadata for persistent objects
 *
 * The models are a combination of TypeORM Entities and TypeGraphQL Types
 */
@ObjectType({
  description: 'Persistence model which will be saved in DB',
  isAbstract: true,
})
export abstract class PersistenceModel extends CorePersistenceModel {
  /**
   * Editor who created the object
   *
   * Not set when created by system
   */
  @Field((type) => Editor, {
    description: 'Editor who created the object',
    nullable: true,
  })
  @Column('varchar')
  createdBy?: string | Editor = undefined;

  /**
   * Editor who last updated the object
   *
   * Not set when updated by system
   */
  @Field((type) => Editor, {
    description: 'Editor who last updated the object',
    nullable: true,
  })
  @Column('varchar')
  updatedBy?: string | Editor = undefined;
}
