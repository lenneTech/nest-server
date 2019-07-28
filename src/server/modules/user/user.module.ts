import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import envConfig from '../../../config.env';
import { JSON } from '../../../core/common/scalars/json.scalar';
import { ConfigService } from '../../../core/common/services/config.service';
import { EmailService } from '../../../core/common/services/email.service';
import { TemplateService } from '../../../core/common/services/template.service';
import { AvatarController } from './avatar.controller';
import { User } from './user.model';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

/**
 * User module
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [AvatarController],
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService(envConfig),
    },

    // Standard services
    EmailService, TemplateService, JSON, UserResolver, UserService,
  ],
  exports: [ConfigService, EmailService, TemplateService, JSON, TypeOrmModule, UserResolver, UserService],
})
export class UserModule {
}
