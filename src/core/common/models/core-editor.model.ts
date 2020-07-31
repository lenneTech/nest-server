import { Field, ID, ObjectType } from '@nestjs/graphql';
import { CoreModel } from './core-model.model';

@ObjectType({ description: 'Editor', isAbstract: true })
export abstract class CoreEditorModel extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * ID of the persistence object
   */
  @Field((type) => ID, { description: 'ID of the editor' })
  id: string = undefined;

  /**
   * E-Mail address of the user
   */
  @Field({ description: 'Email of the editor', nullable: true })
  email: string = undefined;

  /**
   * First name of the user
   */
  @Field({ description: 'First name of the editor', nullable: true })
  firstName: string = undefined;

  /**
   * Last name of the user
   */
  @Field({ description: 'Last name of the editor', nullable: true })
  lastName: string = undefined;

  /**
   * Username of the user
   */
  @Field({ description: 'Username of the editor', nullable: true })
  username: string = undefined;
}
