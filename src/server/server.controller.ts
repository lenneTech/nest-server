import { Controller, Get, Render } from '@nestjs/common';

import { ConfigService, RoleEnum, Roles } from '..';

@Roles(RoleEnum.ADMIN)
@Controller()
export class ServerController {
  constructor(protected configService: ConfigService) {}

  @Roles(RoleEnum.S_EVERYONE)
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
    return JSON.parse(JSON.stringify(this.configService.configFastButReadOnly));
  }
}
