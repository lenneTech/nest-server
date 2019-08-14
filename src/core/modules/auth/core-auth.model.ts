import { Field, ObjectType } from 'type-graphql';

/**
 * CoreAuth model for the response after the sign in
 */
@ObjectType({ description: 'CoreAuth', isAbstract: true })
export class CoreAuthModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * JavaScript Web Token (JWT)
   */
  @Field({ description: 'JavaScript Web Token (JWT)' })
  token: string;
}
