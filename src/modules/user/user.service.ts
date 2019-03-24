import { Injectable, NotFoundException } from '@nestjs/common';
import { User } from './user.model';
import { UserInput } from './inputs/user.input';
import { UserCreateInput } from './inputs/user-create.input';
import { PubSub } from 'graphql-subscriptions';

const pubSub = new PubSub();

/**
 * User service
 */
@Injectable()
export class UserService {

  /**
   * Mock for user DB
   */
  private readonly users: User[] = [
    {
      id: '1',
      firstName: 'Test',
      lastName: 'User',
      email: 'test@test.de',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: '2',
      firstName: 'Next',
      lastName: 'User',
      email: 'test@test.de',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  /**
   * Create user
   */
  create(input: UserCreateInput): User {

    // Create user data
    const createdUser: any = Object.assign(input, {

      // Random id
      id: Math.random().toString(36).substring(7),

      // Create and update dates
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Save user
    this.users.push(createdUser);

    // Inform subscriber
    pubSub.publish('userCreated', { userCreated: createdUser });

    // Return user
    return createdUser;
  }

  /**
   * Get all users
   */
  find(): User[] {
    return this.users;
  }

  /**
   * Get user via ID
   */
  get(id: string): User {
    const user =  this.users.find(user => user.id === id);
    if (!user) {
      throw new NotFoundException();
    }
    return user;
  }

  /**
   * Get user via ID
   */
  update(id: string, input: UserInput): User {

    // Search user
    const user = this.users.find(item => item.id === id);

    // Check user
    if (!user) {
      throw new NotFoundException();
    }

    // Update user
    Object.assign(user, input);
    user.updatedAt = new Date();

    // Return user
    return user;
  }

  /**
   * Delete user via ID
   */
  delete(id: string): User {

    // Search user
    const pos = this.users.findIndex(item => item.id === id);

    // Check user
    if (pos === -1) {
      throw new NotFoundException();
    }

    // Delete user
    const user = this.users[pos];
    this.users.splice(pos, 1);

    // Return deleted user
    return user;
  }
}
