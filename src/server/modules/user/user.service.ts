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
   *
   * REFERENCE IMPLEMENTATION — the two details below are the ones that matter, and a project
   * copying this method needs both. Either one alone leaves the endpoint an account oracle.
   *
   * 1. An unknown address yields `null` (since 11.38.0, unless
   *    `auth.passwordReset.preventUserEnumeration` is off) and this method returns quietly, so the
   *    caller answers the same way it would for a known one.
   * 2. The mail send is NOT awaited. This is the half that actually closes the channel: the send
   *    is a network round trip to SMTP or Brevo, orders of magnitude above everything else in the
   *    request. Awaiting it would make the known path visibly slower whatever the status code says
   *    — you would have given up the "unknown address" hint in the UI and kept the oracle.
   *
   * A failed send must still be reported rather than crash the process, which is why it carries
   * its own `catch`. The user is told the mail is on its way either way; that is the same trade
   * Better-Auth makes on the IAM path.
   */
  async sendPasswordResetMail(email: string, serviceOptions?: ServiceOptions): Promise<null | User> {
    // `createPasswordResetToken`, not `setPasswordResetTokenForEmail`: the latter returns the user
    // through `process()`, where the security interceptor strips `passwordResetToken`. Reading the
    // token off that object is what mailed the word `undefined` to a real recipient.
    const created = await this.createPasswordResetToken(email, serviceOptions);

    if (!created) {
      // Unknown address, enumeration protection on. Answer exactly as for a known one.
      return null;
    }

    // `buildPasswordResetLink`, not string concatenation: `email.passwordResetLink` has no default,
    // and this config file does not set one, so concatenating produced `undefined/<token>`.
    const link = this.buildPasswordResetLink(created.token);
    if (!link) {
      // Sending a mail whose link cannot work is worse than sending none. The recipient has no
      // second way in, and a dead link gives them nothing to act on — while no mail at least reads
      // as "try again". The address is still answered exactly as a known one.
      this.userServiceLogger.error(
        'Password reset mail not sent: no reset link could be built. Set `email.passwordResetLink` or `appUrl`.',
      );
      return created.user;
    }

    // Deliberately NOT awaited — see the note above.
    void this.emailService
      .sendMail(created.user.email, 'Password reset', {
        htmlTemplate: 'password-reset',
        templateData: {
          link,
          // The mail is the only place the recipient can learn there IS a deadline. Without it an
          // expired link is indistinguishable from a broken one — the same experience this whole
          // area was repaired for.
          linkExpiresInMinutes: this.passwordResetTokenExpiryMinutes(),
          name: created.user.username,
        },
      })
      .catch((error: unknown) => {
        this.userServiceLogger.error(
          `Failed to send the password-reset mail: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    // Return user
    return created.user;
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
