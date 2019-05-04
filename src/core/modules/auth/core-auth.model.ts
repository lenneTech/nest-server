import { Field, ObjectType } from 'type-graphql';

/**
 * CoreAuth model for the response after the sign in
 */
@ObjectType({ description: 'Auth', isAbstract: true })
export class CoreAuth {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JavaScript Web Token (JWT)
   */
  @Field({ description: 'JavaScript Web Token (JWT)' })
  token: string;
}
