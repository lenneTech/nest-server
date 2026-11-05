import { Controller, Get, Render } from '@nestjs/common';

import { ConfigService, configEndpointResponse, RoleEnum, Roles } from '../index.js';

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

  /**
   * The configuration with every secret masked, and only where `configEndpoint` opens the route (by default in
   * `local`, `ci` and `e2e`; 404 elsewhere). It used to return the configuration verbatim — database URI, auth
   * secrets, mail password — to every administrator.
   */
  @Get('config')
  @Roles(RoleEnum.ADMIN)
  config() {
    return configEndpointResponse();
  }
}
