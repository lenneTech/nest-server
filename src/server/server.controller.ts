import { Controller, Get, Render } from '@nestjs/common';

import { ConfigService, RoleEnum, Roles } from '..';

@Controller()
@Roles(RoleEnum.ADMIN)
export class ServerController {
  constructor(protected configService: ConfigService) {}

  @Get()
  @Render('index')
  @Roles(RoleEnum.S_EVERYONE)
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
