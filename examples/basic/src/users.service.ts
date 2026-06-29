import { conflict } from '@kivin/core';
import { Injectable } from '@kivin/decorators';
import type { Logger } from '@kivin/logger';
import { LOGGER } from '@kivin/logger';
import type { CreateUserInput, PatchUserInput, ReplaceUserInput } from './users.schemas';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`User ${id} was not found`);
  }
}

@Injectable({ deps: [LOGGER] })
export class UserService {
  private readonly logger: Logger;
  private readonly users: UserRecord[] = [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
  ];

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'UserService' });
  }

  list(search?: string) {
    this.logger.debug('users.list', { search: search ?? null });
    if (!search) {
      return this.users;
    }

    const keyword = search.toLowerCase();
    return this.users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
  }

  findById(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  requireById(id: string) {
    const user = this.findById(id);
    if (!user) {
      this.logger.warn('users.not_found', { id });
      throw new UserNotFoundError(id);
    }
    return user;
  }

  create(input: CreateUserInput) {
    this.ensureEmailAvailable(input.email);
    const nextUser = {
      id: String(this.users.length + 1),
      name: input.name,
      email: input.email,
    };
    this.users.push(nextUser);
    this.logger.info('users.created', { id: nextUser.id, email: nextUser.email });
    return nextUser;
  }

  replace(id: string, input: ReplaceUserInput) {
    const user = this.requireById(id);
    this.ensureEmailAvailable(input.email, id);
    user.name = input.name;
    user.email = input.email;
    this.logger.info('users.replaced', { id: user.id, email: user.email });
    return user;
  }

  patch(id: string, input: PatchUserInput) {
    const user = this.requireById(id);

    if (input.email && input.email !== user.email) {
      this.ensureEmailAvailable(input.email, id);
      user.email = input.email;
    }

    if (input.name) {
      user.name = input.name;
    }

    this.logger.info('users.patched', { id: user.id, email: user.email });
    return user;
  }

  remove(id: string) {
    const index = this.users.findIndex((user) => user.id === id);
    if (index === -1) {
      this.logger.warn('users.not_found', { id });
      throw new UserNotFoundError(id);
    }

    const [removedUser] = this.users.splice(index, 1);
    if (removedUser) {
      this.logger.info('users.deleted', { id: removedUser.id, email: removedUser.email });
    }
  }

  private ensureEmailAvailable(email: string, currentUserId?: string) {
    const duplicate = this.users.find((user) => user.email === email && user.id !== currentUserId);
    if (!duplicate) {
      return;
    }

    this.logger.warn('users.email_conflict', { email, currentUserId: currentUserId ?? null, duplicateUserId: duplicate.id });
    throw conflict(`User email ${email} is already in use`);
  }
}
