import { Type } from '@nestjs/common';
import { Field } from 'type-graphql';
import { IAuthModel } from './interfaces/auth-model.interface';
import { IAuthUser } from './interfaces/auth-user.interface';

/**
 * Function to create AuthModel
 */
function createAuth(userClass: Type<IAuthUser>): Type<IAuthModel> {

  /**
   * Auth model for the response after the sign in
   */
  class AuthModel {

    // ===================================================================================================================
    // Properties
    // ===================================================================================================================

    /**
     * JavaScript Web Token (JWT)
     */
    @Field({ description: 'JavaScript Web Token (JWT)' })
    token: string;

    /**
     * Signed in user
     */
    @Field(type => userClass, { description: 'User who signed in' })
    user: IAuthUser;
  }

  return AuthModel;
}

/**
 * AuthModel
 */
export const Auth = createAuth;
