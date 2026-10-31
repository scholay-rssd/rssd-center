import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseFilters, Catch, ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RssdService } from './rssd.service';
const { ProtocolError } = require('../../../../rssd/protocol.cjs');

@Catch(ProtocolError)
class RssdProtocolFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(error.status).json({message: error.message, code: error.code});
  }
}

@Controller('/rssd/v1')
@UseFilters(RssdProtocolFilter)
@Throttle({ default: { limit: 600, ttl: 60000 } })
export class RssdController {
  constructor(private rssd: RssdService) {}
  @Get('/identity') identity(@Req() req: any) { return {protocolVersion: 1, ...req.rssd}; }
  @Get('/registry') registry(@Req() req: any) { return this.rssd.store.registry(req.rssd); }
  @Post('/workspaces') workspace(@Req() req: any, @Body() body: any) { return this.rssd.store.saveWorkspace(req.rssd, body.workspace, body.baseRevision); }
  @Get('/workers') workers(@Req() req: any) { return this.rssd.store.workers(req.rssd); }
  @Post('/workers') createWorker(@Req() req: any, @Body() body: any) { return this.rssd.store.createWorker(req.rssd, body); }
  @Post('/workers/:id/revoke') revokeWorker(@Req() req: any, @Param('id') id: string) { return this.rssd.store.revokeWorker(req.rssd, id); }
  @Post('/heartbeat') heartbeat(@Req() req: any, @Body() body: any) { return this.rssd.store.heartbeat(req.rssd, body); }
  @Get('/demands') demands(@Req() req: any, @Query() query: any) { return this.rssd.store.demands(req.rssd, query); }
  @Post('/demands') createDemand(@Req() req: any, @Body() body: any) { return this.rssd.store.createDemand(req.rssd, body); }
  @Patch('/demands/:id') changeDemand(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.rssd.store.changeDemand(req.rssd, id, body); }
  @Post('/claims') claim(@Req() req: any, @Body() body: any) { return this.rssd.store.claim(req.rssd, body); }
  @Get('/claims/current') activeClaim(@Req() req: any) { return this.rssd.store.activeClaim(req.rssd); }
  @Get('/works') works(@Req() req: any, @Query() query: any) { return this.rssd.store.works(req.rssd, query); }
  @Get('/works/:id') work(@Req() req: any, @Param('id') id: string) { return this.rssd.store.work(req.rssd, id); }
  @Get('/works/:id/editions/:locale/:revision') edition(@Req() req: any, @Param('id') id: string, @Param('locale') locale: string, @Param('revision') revision: string) { return this.rssd.store.edition(req.rssd, id, locale, Number(revision)); }
  @Post('/drafts') saveDraft(@Req() req: any, @Body() body: any) { return this.rssd.store.submit(req.rssd, body, {publish: false}); }
  @Post('/submissions') submit(@Req() req: any, @Body() body: any) { return this.rssd.store.submit(req.rssd, body); }
  @Get('/submissions/:id') submission(@Req() req: any, @Param('id') id: string) { return this.rssd.store.submissionStatus(req.rssd, id); }
  @Get('/publications') publications(@Req() req: any, @Query() query: any) { return this.rssd.store.publications(req.rssd, query); }
}
