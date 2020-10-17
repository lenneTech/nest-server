import { EntityRepository } from '@mikro-orm/core';
import { InternalServerErrorException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { Filter } from '../../../core/common/helpers/filter.helper';
import { ICorePersistenceModel } from '../../common/interfaces/core-persistence-model.interface';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
export abstract class CoreBasicUserService<
  TUser = CoreUserModel,
  TUserInput = CoreUserInput,
  TUserCreateInput = CoreUserCreateInput
> {
  /**
   * User repository
   */
  protected readonly db: EntityRepository<any>;

  /**
   * User model
   */
  protected readonly model: ICorePersistenceModel;

  /**
   * Create user
   */
  async create(input: TUserCreateInput, ...args: any[]): Promise<TUser> {
    // Prepare input
    if ((input as any).password) {
      (input as any).password = await bcrypt.hash((input as any).password, 10);
    }

    // Create new user
    const createdUser = this.model.map(input);

    try {
      // Save created user
      await this.db.persistAndFlush(createdUser);
    } catch (error) {
      if (error.code === 11000) {
        throw new UnprocessableEntityException(`User with email address "${(input as any).email}" already exists`);
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
  async get(id: string, ...args: any[]): Promise<TUser> {
    const user = await this.db.findOneOrFail(id);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get user via email
   */
  async getViaEmail(email: string, ...args: any[]): Promise<TUser> {
    const user = await this.db.findOne({ email });
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs, ...args: any[]): Promise<TUser[]> {
    // Return found users
    return this.db.find(...Filter.convertFilterArgsToQuery(filterArgs));
  }

  /**
   * Get user via ID
   */
  async update(id: string, input: TUserInput, ...args: any[]): Promise<TUser> {
    // Check if user exists
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    if ((input as any).password) {
      (input as any).password = await bcrypt.hash((input as any).password, 10);
    }

    // Map
    user.map(input);

    // Search user
    await this.db.persistAndFlush(user);

    // Return user
    return user;
  }

  /**
   * Delete user via ID
   */
  async delete(id: string, ...args: any[]): Promise<TUser> {
    // Search user
    const user = await this.db.findOne(id);

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    const deleted = await this.db.remove(user);

    // Check deleted
    if (!deleted) {
      throw new InternalServerErrorException();
    }

    // Return deleted user
    return user;
  }
}
