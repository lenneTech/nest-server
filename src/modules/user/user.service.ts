import { Injectable } from '@nestjs/common';
import { User } from './user.model';

@Injectable()
export class UserService {
  private readonly users: User[] = [{
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
    }];

  create(user: User): User {
    this.users.push(user);
    return user;
  }

  findAll(): User[] {
    return this.users;
  }

  findOneById(id: string): User {
    return this.users.find(user => user.id === id);
  }
}
