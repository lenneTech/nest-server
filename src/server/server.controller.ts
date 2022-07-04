import { Controller, Get, Render } from '@nestjs/common';
import { ConfigService, RoleEnum, Roles } from '..';

@Controller()
export class ServerController {
  constructor(protected configService: ConfigService) {}

  @Get()
  @Render('index')
  root() {
    return {
      env: this.configService.getFastButReadOnly('env'),
    };
  }

  @Get('config')
  @Roles(RoleEnum.ADMIN)
  config() {
    return this.configService.configFastButReadOnly;
  }
}
