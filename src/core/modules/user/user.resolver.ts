import { Inject, mixin, Type } from '@nestjs/common';
import { Args, Mutation, Query, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/roles.enum';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { IUserResolver } from './interfaces/user-resolver.interface';
import { IUserService } from './interfaces/user-service.interface';
import { IUser } from './interfaces/user.interface';
import { UserService } from './user.service';

// Subscription
const pubSub = new PubSub();

/**
 * Function to create UserResolver class
 */
function createUserResolver(userClass: Type<IUser>): Type<IUserResolver> {

  /**
   * Resolver to process with user data
   */
  class MixinUserResolver {

    /**
     * Import services
     */
    constructor(@Inject('UserService') private readonly usersService: IUserService) {}

    // ===========================================================================
    // Queries
    // ===========================================================================

    /**
     * Get user via ID
     */
    @Query(returns => userClass, { description: 'Get user with specified ID' })
    async getUser(@Args('id') id: string): Promise<IUser> {
      return await this.usersService.get(id);
    }

    /**
     * Get users (via filter)
     */
    @Roles(RoleEnum.USER)
    @Query(returns => [userClass], { description: 'Find users (via filter)' })
    async findUsers(@Args() args?: FilterArgs): Promise<IUser[]> {
      return await this.usersService.find(args);
    }

    // ===========================================================================
    // Mutations
    // ===========================================================================

    /**
     * Create new user
     */
    @Mutation(returns => userClass, { description: 'Create a new user' })
    async createUser(@Args('input') input: UserCreateInput): Promise<IUser> {
      return await this.usersService.create(input);
    }

    /**
     * Update existing user
     */
    @Roles(RoleEnum.ADMIN, RoleEnum.OWNER)
    @Mutation(returns => userClass, { description: 'Update existing user' })
    async updateUser(
      @Args('input') input: UserInput,
      @Args('id') id: string,
    ): Promise<IUser> {
      return await this.usersService.update(id, input);
    }

    /**
     * Delete existing user
     */
    @Roles(RoleEnum.ADMIN, RoleEnum.OWNER)
    @Mutation(returns => userClass, { description: 'Delete existing user' })
    async deleteUser(@Args('id') id: string): Promise<IUser> {
      return await this.usersService.delete(id);
    }

    // ===========================================================================
    // Subscriptions
    // ===========================================================================

    /**
     * Subscritption for create user
     */
    @Subscription(returns => userClass)
    userCreated() {
      return pubSub.asyncIterator('userCreated');
    }
  }

  const userResolver = mixin(MixinUserResolver);
  return userResolver;
}

/**
 * UserResolver
 */
export const UserResolver = createUserResolver;
