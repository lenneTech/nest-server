import { Injectable, InternalServerErrorException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { MongoRepository } from 'typeorm';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { Filter } from '../../../core/common/helpers/filter.helper';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';

// Subscription
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

    // Prepare input
    if (input.password) {
     input.password = await bcrypt.hash(input.password, 10);
    }

    // Create new user
    const createdUser = this.db.create(input);

    try {

      // Save created user
      let savedUser = await this.db.save(createdUser);
      if (!savedUser) {
        throw new InternalServerErrorException();
      }

      // Set user as owner of itself
      savedUser.ownerIds.push(savedUser.id.toString());
      savedUser = await this.db.save(savedUser);
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
   * Get user via ID
   */
  async get(id: string): Promise<User> {
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get user via email
   */
  async getViaEmail(email: string): Promise<User> {
    const user = await this.db.findOne({email});
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

    // Prepare input
    if (input.password) {
      input.password = await bcrypt.hash(input.password, 10);
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
