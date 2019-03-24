import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PubSub } from 'graphql-subscriptions';
import { FindManyOptions, MongoRepository } from 'typeorm';
import { FilterArgs } from '../../common/args/filter.args';
import { Filter } from '../../common/helper/filter.class';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';

const pubSub = new PubSub();

/**
 * User service
 */
@Injectable()
export class UserService {

  /**
   * User repository
   */
  @InjectRepository(User)
  protected readonly db: MongoRepository<User>;

  /**
   * Create user
   */
  async create(input: UserCreateInput): Promise<User> {

    // Create new user
    const createdUser = this.db.create(input);

    try {

      // Save created user
      const savedUser = await this.db.save(createdUser);
      if (!savedUser) {
        throw new InternalServerErrorException();
      }

    } catch (error) {
      if (error.code === 11000) {
        throw new UnprocessableEntityException(`User with email address "${input.email}" already exists`);
      } else {
        throw new UnprocessableEntityException();
      }
    }

    // Inform subscriber
    pubSub.publish('userCreated', { userCreated: createdUser });

    // Return created user
    return createdUser;
  }

  /**
   * Get uer via ID
   */
  async get(id: string): Promise<User> {
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs): Promise<User[]> {

    // Return found users
    return this.db.find(Filter.generateFilterOptions(filterArgs));
  }

  /**
   * Get user via ID
   */
  async update(id: string, input: UserInput): Promise<User> {

    // Check if user exists
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Search user
    await this.db.update(id, input);

    // Return user
    return Object.assign(user, input);
  }

  /**
   * Delete user via ID
   */
  async delete(id: string): Promise<User> {

    // Search user
    const user = await this.db.findOne(id);

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    const deleted = await this.db.delete(id);

    // Check deleted
    if (!deleted) {
      throw new InternalServerErrorException();
    }

    // Return deleted user
    return user;
  }
}
