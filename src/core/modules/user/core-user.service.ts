import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PubSub } from 'graphql-subscriptions';
import { FilterArgs } from '../../common/args/filter.args';
import { Filter } from '../../common/helpers/filter.helper';
import { CoreBasicUserService } from './core-basic-user.service';
import { CoreUserModel } from './core-user.model';
import { CoreUserCreateInput } from './inputs/core-user-create.input';
import { CoreUserInput } from './inputs/core-user.input';
import { Model } from 'mongoose';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
export abstract class CoreUserService<
  TUser = CoreUserModel,
  TUserInput = CoreUserInput,
  TUserCreateInput = CoreUserCreateInput
> extends CoreBasicUserService<TUser, TUserInput, TUserCreateInput> {
  protected constructor(protected readonly userModel: Model<any>) {
    super(userModel);
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create user
   */
  async create(input: TUserCreateInput, currentUser?: TUser, ...args: any[]): Promise<TUser> {
    // Prepare input
    await this.prepareInput(input, currentUser, { create: true });

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

    // Prepare output
    await this.prepareOutput(createdUser, args[0]);

    // Inform subscriber
    pubSub.publish('userCreated', { userCreated: createdUser });

    // Return created user
    return createdUser;
  }

  /**
   * Delete user via ID
   */
  async delete(id: string, ...args: any[]): Promise<TUser> {
    // Search user
    let user = await this.userModel.findOne({ _id: id }).exec();

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Delete user
    await this.userModel.deleteOne({ _id: id }).exec();

    user = this.model.map(user);

    // Return deleted user
    return await this.prepareOutput(user, args[0]);
  }

  /**
   * Get user via ID
   */
  async get(id: string, ...args: any[]): Promise<TUser> {
    const user = await this.userModel.findOne({ _id: id }).exec();

    if (!user) {
      throw new NotFoundException();
    }

    return this.prepareOutput(this.model.map(user), args[0]);
  }

  /**
   * Get users via filter
   */
  async find(filterArgs?: FilterArgs, ...args: any[]): Promise<TUser[]> {
    const filterQuery = Filter.convertFilterArgsToQuery(filterArgs);
    // Return found users
    return await Promise.all(
      (
        await this.userModel.find(filterQuery[0], null, filterQuery[1]).exec()
      ).map((user) => {
        return this.prepareOutput(user, args[0]);
      })
    );
  }

  /**
   * Update user via ID
   */
  async update(id: string, input: TUserInput, currentUser: TUser, ...args: any[]): Promise<TUser> {
    // Check if user exists
    let user = await this.userModel.findOne({ _id: id }).exec();

    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    await this.prepareInput(input, currentUser);

    // Update
    user.set(input);

    // Save
    await user.save();

    // Map for response
    user = this.model.map(user);

    // Return user
    return await this.prepareOutput(user as TUser, args[0]);
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(
    input: { [key: string]: any },
    currentUser: TUser,
    options: { [key: string]: any; create?: boolean; clone?: boolean } = {},
    ...args: any[]
  ) {
    // Configuration
    const config = {
      clone: false,
      ...options,
    };

    // Clone output
    if (config.clone) {
      input = JSON.parse(JSON.stringify(input));
    }

    // Has password
    if (input.password) {
      input.password = await bcrypt.hash((input as any).password, 10);
    }

    // Return prepared input
    return input;
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(
    user: TUser,
    options: { [key: string]: any; clone?: boolean } = {},
    ...args: any[]
  ): Promise<TUser> {
    // Configuration
    const config = {
      clone: true,
      ...options,
    };

    // Clone user
    if (config.clone) {
      user = JSON.parse(JSON.stringify(user));
    }

    // Remove password if exists
    delete (user as any).password;

    // Return prepared user
    return user;
  }
}
