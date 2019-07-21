import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { GraphQLResolveInfo } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import { CoreUserCreateInput, CoreUserInput, CoreUserModel, Filter, FilterArgs } from '../../..';
import { CoreBasicUserService } from './core-basic-user.service';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
@Injectable()
export abstract class CoreUserService<TUser = CoreUserModel, TUserInput = CoreUserInput, TUserCreateInput = CoreUserCreateInput>
  extends CoreBasicUserService<TUser, TUserInput, TUserCreateInput> {

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
    return await this.prepareOutput(user, args[0]);
  }

  /**
   * Get user via ID
   */
  async get(id: string, ...args: any[]): Promise<TUser> {
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException();
    }
    return this.prepareOutput(user, args[0]);
  }

  /**
   * Get users via filter
   */
  async find(filterArgs?: FilterArgs, ...args: any[]): Promise<TUser[]> {

    // Return found users
    return await Promise.all((await this.db.find(Filter.generateFilterOptions(filterArgs))).map((user) => {
      return this.prepareOutput(user, args[0]);
    }));
  }

  /**
   * Get user via ID
   */
  async update(id: string, input: TUserInput, currentUser: TUser, ...args: any[]): Promise<TUser> {

    // Check if user exists
    const user = await this.db.findOne(id);
    if (!user) {
      throw new NotFoundException(`User not found with ID: ${id}`);
    }

    // Prepare input
    await this.prepareInput(input, currentUser);

    // Search user
    await this.db.update(id, input);

    // Return user
    return await this.prepareOutput(Object.assign(user, input) as TUser, args[0]);
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(input: { [key: string]: any }, currentUser: TUser, options: { create?: boolean } = {}, ...args: any[]) {

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
  protected async prepareOutput(user: TUser, ...args: any[]): Promise<TUser> {
    // Remove password if exists
    delete (user as any).password;

    // Return prepared user
    return user;
  }
}
