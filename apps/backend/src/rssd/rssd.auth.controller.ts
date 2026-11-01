import { Body, Controller, Header, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { Throttle } from '@nestjs/throttler';
import { RssdService } from './rssd.service';
import { RssdProtocolFilter } from './rssd.controller';

// Only these two bootstrap routes bypass browser/device authentication.
@Controller('/rssd/v1/auth')
@UseFilters(RssdProtocolFilter)
@UseGuards(ThrottlerRealIpGuard)
export class RssdAuthController {
  constructor(private rssd: RssdService) {}
  @Post('/start')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  start(@Body() body: any) { return this.rssd.authorization.start(body); }
  @Post('/token')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  token(@Body() body: any) { return this.rssd.authorization.exchange(body); }
}
