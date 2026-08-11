import { Inject, Injectable, Optional, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { PubSub } from 'graphql-subscriptions';
import { Model } from 'mongoose';

import { getTranslatablePropertyKeys, updateLanguage } from '../../../core/common/decorators/translatable.decorator';
import { ServiceOptions } from '../../../core/common/interfaces/service-options.interface';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { CoreModelConstructor } from '../../../core/common/types/core-model-constructor.type';
import { CoreBetterAuthUserMapper } from '../../../core/modules/better-auth/core-better-auth-user.mapper';
import { CoreUserService } from '../../../core/modules/user/core-user.service';
import { UserCreateInput } from './inputs/user-create.input';
import { UserInput } from './inputs/user.input';
import { User, UserDocument } from './user.model';

/**
 * User service
 */
@Injectable()
export class UserService extends CoreUserService<User, UserInput, UserCreateInput> {
  // ===================================================================================================================
  // Injections
  // ===================================================================================================================

  /**
   * Constructor for injecting services
   */
  constructor(
    protected override readonly configService: ConfigService,
    protected override readonly emailService: EmailService,
    @Inject('USER_CLASS') protected override readonly mainModelConstructor: CoreModelConstructor<User>,
    @InjectModel('User') protected override readonly mainDbModel: Model<UserDocument>,
    @Inject('PUB_SUB') protected readonly pubSub: PubSub,
    @Optional() private readonly betterAuthUserMapper?: CoreBetterAuthUserMapper,
  ) {
    super(configService, emailService, mainDbModel, mainModelConstructor, { betterAuthUserMapper });
  }

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================

  /**
   * Create new user and send welcome email
   */
  override async create(input: UserCreateInput, serviceOptions?: ServiceOptions): Promise<User> {
    // Get prepared user
    let user = await super.create(input, serviceOptions);

    // Add the createdBy information in an extra step if it was not set by the system because the user created himself
    // and could not exist as currentUser before
    if (!user.createdBy) {
      await this.mainDbModel.findByIdAndUpdate(user.id, { createdBy: user.id });
      user = await this.get(user.id, { ...serviceOptions, currentUser: serviceOptions?.currentUser || user });
    }

    // Publish action
    if (serviceOptions?.pubSub === undefined || serviceOptions.pubSub) {
      await this.pubSub.publish('userCreated', User.map(user));
    }

    // Return created user
    return user;
  }

  override async update(id: string, input: UserInput, serviceOptions?: ServiceOptions): Promise<User> {
    const dbObject = await super.get(id, serviceOptions);
    if (serviceOptions.language && serviceOptions.language !== 'de') {
      input = updateLanguage(serviceOptions.language, input, dbObject as UserInput, getTranslatablePropertyKeys(User));
    }
    return super.update(id, input, serviceOptions);
  }

  /**
   * Request password reset mail
   */
  async sendPasswordResetMail(email: string, serviceOptions?: ServiceOptions): Promise<User> {
    // Set password reset token
    const user = await super.setPasswordResetTokenForEmail(email, serviceOptions);

    // Send email
    await this.emailService.sendMail(user.email, 'Password reset', {
      htmlTemplate: 'password-reset',
      templateData: {
        link: `${this.configService.configFastButReadOnly.email.passwordResetLink}/${user.passwordResetToken}`,
        name: user.username,
      },
    });

    // Return user
    return user;
  }

  /**
   * Point the user's avatar at an already-stored file
   *
   * Takes the file ID rather than the upload itself: the bytes belong in the central
   * file storage (GridFS/S3) so every replica can serve them, and putting that
   * dependency here is not possible — `UserService` is instantiated by
   * `CoreAuthModule`, which knows nothing about the project's `FileModule`.
   * `AvatarController` therefore stores the file and calls this with the resulting id.
   *
   * @returns the PREVIOUS avatar id, so the caller can delete the orphaned file
   */
  async setAvatar(avatarId: string, user: User): Promise<string> {
    // `findById`, not `findOne({ id })`: `id` is a Mongoose virtual, so it exists on the
    // document but not in MongoDB — a filter on it matches nothing and every call ended in
    // "session user no longer exists". Broken since the Mongoose migration and never noticed,
    // because no test covers the avatar endpoint.
    const dbUser = await this.mainDbModel.findById(user.id).exec();
    // Check user: the token is valid but the account no longer exists, so the session really is
    // invalid — 401 is right here. (A permission error would have to be 403, see accessDeniedException.)
    if (!dbUser) {
      throw new UnauthorizedException('User of the current session no longer exists');
    }

    // Check file
    if (!avatarId) {
      throw new UnprocessableEntityException('Missing avatar file');
    }

    const previousAvatar = dbUser.avatar;

    // The avatar is referenced by file id and served via GET /files/id/:id
    dbUser.avatar = avatarId;

    await dbUser.save();

    return previousAvatar;
  }
}
