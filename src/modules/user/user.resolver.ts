import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { User } from './user.model';
import { UserService } from './user.service';
import { UserInput } from './user.input';
import { Filter } from '../../common/args/filter.args';

const pubSub = new PubSub();

@Resolver(of => User)
export class UserResolver {
  constructor(private readonly usersService: UserService) {
  }

  @Query(returns => [User], { description: 'Get all users' })
  async getUsers(@Args() filter?: Filter) {
    return await this.usersService.findAll();
  }

  @Query(returns => User, { description: 'Get user with specified ID' })
  async findOneById(
    @Args('id') id: string,
  ): Promise<User> {
    return await this.usersService.findOneById(id);
  }

  @Mutation(returns => User, { description: 'Create a new user' })
  async create(@Args('input') input: UserInput): Promise<User> {

    // Create user data
    const user: any = Object.assign(input, {
      id: Math.random().toString(36).substring(7),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const createdUser = await this.usersService.create(user);
    pubSub.publish('userCreated', { userCreated: createdUser });
    return createdUser;
  }

  @Subscription(returns => User)
  userCreated() {
    return pubSub.asyncIterator('userCreated');
  }
}
