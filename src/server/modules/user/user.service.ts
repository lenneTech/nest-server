import { Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import { GraphQLResolveInfo } from 'graphql';
import { PubSub } from 'graphql-subscriptions';
import { MongoRepository } from 'typeorm';
import envConfig from '../../../config.env';
import { FilterArgs } from '../../../core/common/args/filter.args';
import { Filter } from '../../../core/common/helpers/filter.helper';
import { GraphQLHelper } from '../../../core/common/helpers/graphql.helper';
import { InputHelper } from '../../../core/common/helpers/input.helper';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { TemplateService } from '../../../core/common/services/template.service';
import { CoreUserService } from '../../../core/modules/user/core-user.service';
import { Editor } from '../../common/models/editor.model';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User } from './user.model';

// Subscription
const pubSub = new PubSub();

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService<User, UserInput, UserCreateInput> {

  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  /**
   * User repository
   */
  @InjectRepository(User)
  protected readonly db: MongoRepository<User>;

  // ===================================================================================================================
  // Injections
  // ===================================================================================================================

  /**
   * Constructor for injecting services
   */
  constructor(
    protected readonly configService: ConfigService,
    protected readonly emailService: EmailService,
    protected readonly templateService: TemplateService,
  ) {
    super();
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create new user and send welcome email
   */
  async create(input: UserCreateInput, currentUser?: User, ...args: any[]): Promise<User> {
      const user = await super.create(input, currentUser);
      const text = `Welcome ${user.firstName}, this is plain text from server.`;
      await this.emailService.sendMail(user.email, 'Welcome', {htmlTemplate: 'welcome', templateData: user, text});
      return user;
  }

  /**
   * Get users via filter
   */
  find(filterArgs?: FilterArgs, ...args: any[]): Promise<User[]> {

    // Return found users
    return this.db.find(Filter.generateFilterOptions(filterArgs, { dbType: this.configService.get('typeOrm.type') }));
  }

  /**
   * Set avatar image
   */
  async setAvatar(file: Express.Multer.File, user: User): Promise<string> {

    // Check user
    if (!user) {
      throw new UnauthorizedException();
    }

    // Check file
    if (!file) {
      throw new UnprocessableEntityException('Missing avatar file');
    }

    // Remove old avatar image
    if (user.avatar) {
      fs.unlink(envConfig.staticAssets.path + '/avatars/' + user.avatar, (err) => {
        if (err) {
          console.log(err);
        }
      });
    }

    // Update user
    await this.db.update(user.id.toString(), { avatar: file.filename });

    // Return user
    return file.filename;
  }

  // ===================================================================================================================
  // Helper methods
  // ===================================================================================================================

  /**
   * Prepare input before save
   */
  protected async prepareInput(input: { [key: string]: any }, currentUser: User, options: { create?: boolean } = {}) {

    // Has password
    if (input.password) {
      input.password = await bcrypt.hash((input as any).password, 10);
    }

    // Set creator
    if (options.create && currentUser) {
      input.createdBy = currentUser.id;
    }

    // Set updater
    if (currentUser) {
      input.updatdBy = currentUser.id;
    }

    // Return prepared input
    return input;
  }

  /**
   * Prepare output before return
   */
  protected async prepareOutput(user: User, info?: GraphQLResolveInfo) {

    // Populate createdBy and updatedBy if necessary (and field is required)
    if (user.createdBy && typeof user.createdBy === 'string' || user.updatedBy && typeof user.updatedBy === 'string') {
      const graphQLFields = GraphQLHelper.getFields(info);

      // Prepare created by (string => Editor)
      if (user.createdBy && typeof user.createdBy === 'string' && GraphQLHelper.isInFields('createdBy', graphQLFields)) {
        user.createdBy = InputHelper.map(await this.get(user.createdBy, info), Editor);
      }

      // Prepare updated by (string => Editor)
      if (user.updatedBy && typeof user.updatedBy === 'string') {
        user.updatedBy = InputHelper.map(await this.get(user.updatedBy, info), Editor);
      }
    }

    // Remove password if exists
    delete user.password;

    // Return prepared user
    return user;
  }
}
