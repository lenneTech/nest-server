import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { GraphQLUser } from '../../../core/common/decorators/graphql-user.decorator';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { InputHelper } from '../../../core/common/helpers/input.helper';
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
    @GraphQLUser() user: User,
  ): Promise<User> {

    // Check input
    // Hint: necessary as long as global CheckInputPipe can't access context for current user
    // (see https://github.com/nestjs/nest/issues/2032)
    input = await InputHelper.check(input, user, User);

    // Update user
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
  @Roles(RoleEnum.ADMIN)
  @Subscription(returns => User)
  userCreated() {
    return pubSub.asyncIterator('userCreated');
  }
}
