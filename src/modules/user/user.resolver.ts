import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { User } from './user.model';
import { UserService } from './user.service';
import { UserInput } from './inputs/user.input';
import { FilterArgs } from '../../common/args/filter.args';
import { UserCreateInput } from './inputs/user-create.input';

const pubSub = new PubSub();

@Resolver(of => User)
export class UserResolver {

  /**
   * Import services
   */
  constructor(private readonly usersService: UserService) {
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  @Query(returns => User, { description: 'Get user with specified ID' })
  async getUser(
    @Args('id') id: string,
  ): Promise<User> {
    return await this.usersService.get(id);
  }

  /**
   * Get users (via filter)
   */
  @Query(returns => [User], { description: 'Get users (via filter)' })
  async getUsers(@Args() filter?: FilterArgs) {
    return await this.usersService.find();
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  /**
   * Create new user
   */
  @Mutation(returns => User, { description: 'Create a new user' })
  async createUser(@Args('input') input: UserCreateInput): Promise<User> {
    return await this.usersService.create(input);
  }

  /**
   * Update existing user
   */
  @Mutation(returns => User, { description: 'Update existing user' })
  async updateUser(
    @Args('input') input: UserInput,
    @Args('id') id: string,
  ): Promise<User> {
    return await this.usersService.update(id, input);
  }

  /**
   * Delete existing user
   */
  @Mutation(returns => User, { description: 'Delete existing user' })
  async deleteUser(
    @Args('id') id: string,
  ): Promise<User> {
    return await this.usersService.delete(id);
  }

  // ===========================================================================
  // Subscriptions
  // ===========================================================================

  /**
   * Subscritption for create user
   */
  @Subscription(returns => User)
  userCreated() {
    return pubSub.asyncIterator('userCreated');
  }
}
