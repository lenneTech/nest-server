import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { convertFilterArgsToQuery } from '../../common/helpers/filter.helper';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';
import { Model } from 'mongoose';
import { ICorePersistenceModel } from '../../common/interfaces/core-persistence-model.interface';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
export abstract class CoreBasicUserService<
  TUser extends CoreUserModel,
  TUserInput extends CoreUserInput,
  TUserCreateInput extends CoreUserCreateInput
> {
  protected readonly model: ICorePersistenceModel;

  constructor(protected readonly userModel: Model<any>) {}

  /**
   * Create user
   */
  async create(input: TUserCreateInput, ...args: any[]): Promise<TUser> {
    // Prepare input
    if ((input as any).password) {
      (input as any).password = await bcrypt.hash((input as any).password, 10);
    }

    // Create new user
    const createdUser = new this.userModel(this.model.map(input));

    try {
      // Save created user
      await createdUser.save();
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
    const user = await this.userModel.findOne({ id: id }).exec();
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get user via email
   */
  async getViaEmail(email: string, ...args: any[]): Promise<TUser> {
    let user = await this.userModel.findOne({ email }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    user = this.model.map(user);

    return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs, ...args: any[]): Promise<TUser[]> {
    // Return found users
    return this.userModel.find(...convertFilterArgsToQuery(filterArgs)).exec();
  }

  /**
   * Get user via ID
   */
  async update(id: string, input: TUserInput, ...args: any[]): Promise<TUser> {
    // Check if user exists
    let user = await this.userModel.findOne({ id });

    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    if ((input as any).password) {
      (input as any).password = await bcrypt.hash((input as any).password, 10);
    }

    // Update
    user.set(input);

    // Save
    await user.save();

    // Map for response
    user = this.model.map(user);

    // Return user
    return user;
  }

  /**
   * Delete user via ID
   */
  async delete(id: string, ...args: any[]): Promise<TUser> {
    // Search user
    const user = await this.userModel.findOne({ id }).exec();

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    await this.userModel.deleteOne({ id: user.id });

    // Return deleted user
    return user;
  }
}
