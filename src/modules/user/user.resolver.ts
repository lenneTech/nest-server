import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/roles.enum';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';
import { UserService } from './user.service';

// Subscription
const pubSub = new PubSub();

/**
 * Resolver to process with user data
 */
@Resolver(of => User)
export class UserResolver {

  /**
   * Import services
   */
  constructor(private readonly usersService: UserService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get user via ID
   */
  @Query(returns => User, { description: 'Get user with specified ID' })
  async getUser(@Args('id') id: string): Promise<User> {
    return await this.usersService.get(id);
  }

  /**
   * Get users (via filter)
   */
  @Roles(RoleEnum.USER)
  @Query(returns => [User], { description: 'Find users (via filter)' })
  async findUsers(@Args() args?: FilterArgs) {
    return await this.usersService.find(args);
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
  @Roles(RoleEnum.ADMIN, RoleEnum.OWNER)
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
  @Roles(RoleEnum.ADMIN, RoleEnum.OWNER)
  @Mutation(returns => User, { description: 'Delete existing user' })
  async deleteUser(@Args('id') id: string): Promise<User> {
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
