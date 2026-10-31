import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseFilters, Catch, ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RssdService } from './rssd.service';
const { ProtocolError } = require('../../../../rssd/protocol.cjs');
const { health } = require('../../../../rssd/health.cjs');

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
  @Get('/health') health(@Req() req: any) { return health(this.rssd.store, req.rssd); }
  @Post('/media') uploadMedia(@Req() req: any, @Body() body: any) { return this.rssd.media.upload(req.rssd, body); }
  @Get('/media/:id') media(@Req() req: any, @Param('id') id: string) { return this.rssd.media.status(req.rssd, id); }
  @Get('/media/:id/raw') async rawMedia(@Req() req: any, @Param('id') id: string, @Res() res: any) {
    const {bytes,row}=await this.rssd.media.bytes(req.rssd,id);
    res.set({'Content-Type':row.manifest.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(bytes);
  }
  @Get('/registry') registry(@Req() req: any) { return this.rssd.store.registry(req.rssd); }
  @Post('/workspaces') workspace(@Req() req: any, @Body() body: any) { return this.rssd.store.saveWorkspace(req.rssd, body.workspace, body.baseRevision); }
  @Get('/workers') workers(@Req() req: any) { return this.rssd.store.workers(req.rssd); }
  @Post('/workers') createWorker(@Req() req: any, @Body() body: any) { return this.rssd.store.createWorker(req.rssd, body); }
  @Post('/workers/:id/revoke') revokeWorker(@Req() req: any, @Param('id') id: string) { return this.rssd.store.revokeWorker(req.rssd, id); }
  @Post('/heartbeat') heartbeat(@Req() req: any, @Body() body: any) { return this.rssd.store.heartbeat(req.rssd, body); }
  @Get('/demands') demands(@Req() req: any, @Query() query: any) { return this.rssd.store.demands(req.rssd, query); }
  @Post('/demands') createDemand(@Req() req: any, @Body() body: any) { return this.rssd.store.createDemand(req.rssd, body); }
  @Patch('/demands/:id') changeDemand(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.rssd.store.changeDemand(req.rssd, id, body); }
  @Post('/claims') async claim(@Req() req: any, @Body() body: any, @Res() res: any) { res.status(201).json(await this.rssd.store.claim(req.rssd, body)); }
  @Get('/claims/current') async activeClaim(@Req() req: any, @Res() res: any) { res.json(await this.rssd.store.activeClaim(req.rssd)); }
  @Get('/works') works(@Req() req: any, @Query() query: any) { return this.rssd.store.works(req.rssd, query); }
  @Get('/works/:id') work(@Req() req: any, @Param('id') id: string) { return this.rssd.store.work(req.rssd, id); }
  @Get('/works/:id/editions/:locale/:revision') edition(@Req() req: any, @Param('id') id: string, @Param('locale') locale: string, @Param('revision') revision: string) { return this.rssd.store.edition(req.rssd, id, locale, Number(revision)); }
  @Post('/drafts') saveDraft(@Req() req: any, @Body() body: any) { return this.rssd.store.submit(req.rssd, body, {publish: false}); }
  @Post('/submissions') submit(@Req() req: any, @Body() body: any) { return this.rssd.store.submit(req.rssd, body); }
  @Get('/submissions/:id') submission(@Req() req: any, @Param('id') id: string) { return this.rssd.store.submissionStatus(req.rssd, id); }
  @Get('/publications') publications(@Req() req: any, @Query() query: any) { return this.rssd.store.publications(req.rssd, query); }
  @Post('/publications/:id/retry') retryPublication(@Req() req: any, @Param('id') id: string) { return this.rssd.publisher.retry(req.rssd, id); }
  @Get('/destinations') destinations(@Req() req: any) { return this.rssd.publisher.destinations(req.rssd); }
  @Get('/channels') channels(@Req() req: any) { return this.rssd.postiz.channels(req.rssd); }
  @Post('/destinations') saveDestination(@Req() req: any, @Body() body: any) { return this.rssd.publisher.saveDestination(req.rssd, body); }
}
