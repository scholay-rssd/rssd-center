import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseFilters, UseGuards, Header, Catch, ExceptionFilter, ArgumentsHost, NotFoundException } from '@nestjs/common';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { Throttle } from '@nestjs/throttler';
import { RssdService } from './rssd.service';
const { ProtocolError } = require('../../../../rssd/protocol.cjs');
const { health } = require('../../../../rssd/health.cjs');

@Catch(ProtocolError)
export class RssdProtocolFilter implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(error.status).json({message: error.message, code: error.code});
  }
}

@Controller('/rssd/v1')
@UseFilters(RssdProtocolFilter)
@Throttle({ default: { limit: 600, ttl: 60000 } })
export class RssdController {
  constructor(private rssd: RssdService) {}
  @Get('/auth/request')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  authorization(@Req() req: any, @Query() query: any) { return this.rssd.authorization.describe(req.rssd, query); }
  @Post('/auth/requests/:id/decision')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  authorize(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.rssd.authorization.decide(req.rssd,id,body); }
  @Get('/coordination/overview') overview(@Req() req: any, @Query() query: any) { return this.rssd.coordination.overview(req.rssd, query); }
  @Get('/coordination/channels') coordinatedChannels(@Req() req: any, @Query() query: any) { return this.rssd.coordination.channels(req.rssd, query); }
  @Get('/coordination/calendar') calendar(@Req() req: any, @Query() query: any) { return this.rssd.coordination.calendar(req.rssd, query); }
  @Get('/goals') goals(@Req() req: any, @Query() query: any) { return this.rssd.coordination.goals(req.rssd, query); }
  @Post('/goals') saveGoal(@Req() req: any, @Body() body: any) { return this.rssd.coordination.saveGoal(req.rssd, body); }
  @Patch('/demands/:id/definition') editDemand(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.rssd.coordination.editDemand(req.rssd, id, body); }
  @Post('/publications/:id/schedule') schedule(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.rssd.coordination.schedule(req.rssd, id, body); }
  @Get('/mcp') mcpStream(@Res() res: any) { res.status(405).set('Allow', 'POST').end(); }
  @Post('/mcp')
  @Header('Cache-Control', 'no-store')
  async mcp(@Req() req: any, @Body() body: any, @Res() res: any) {
    const version = req.headers['mcp-protocol-version'];
    if (version && !['2025-03-26','2025-06-18','2025-11-25'].includes(version)) { res.status(400).json({message:'Unsupported MCP protocol version'}); return; }
    const result = await this.rssd.mcp.handle(req.rssd, body);
    if (result === null) { res.status(202).end(); return; }
    res.status(200).json(result);
  }
  @Get('/identity') identity(@Req() req: any) { return {protocolVersion: 1, ...req.rssd}; }
  @Get('/private-import/status')
  @Header('Cache-Control','private, no-store')
  privateImportStatus(@Req() req: any) { return this.rssd.privateImportStatus(req.rssd); }
  @Get('/private-import/grants/:id/outcome')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  privateImportOutcome(@Req() req: any, @Param('id') id: string) { return this.rssd.privateImportOutcome.read(req.rssd,id); }
  @Post('/private-import/grants')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  @Header('Content-Security-Policy',"default-src 'none'")
  privateImportGrant(@Req() req: any, @Body() body: any) { if (!this.rssd.privateImport) throw new NotFoundException(); return this.rssd.privateImport.issue(req.rssd,body); }
  @Post('/private-import/grants/:id/revoke')
  @Header('Cache-Control','private, no-store')
  privateImportRevoke(@Req() req: any, @Param('id') id: string) { if (!this.rssd.privateImport) throw new NotFoundException(); return this.rssd.privateImport.revoke(req.rssd,id); }
  @Get('/private-review/:workspaceId')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  @Header('Content-Security-Policy',"default-src 'none'")
  privateReviewList(@Req() req: any, @Param('workspaceId') workspaceId: string) { return this.rssd.privateReview.list(req.rssd, workspaceId); }
  @Get('/private-review/:workspaceId/:siteId/:id')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  @Header('Content-Security-Policy',"default-src 'none'")
  privateReviewDetail(@Req() req: any, @Param('workspaceId') workspaceId: string, @Param('siteId') siteId: string, @Param('id') id: string) { return this.rssd.privateReview.detail(req.rssd, workspaceId, siteId, id); }
  @Get('/private-review/:workspaceId/:siteId/:id/files/:index')
  async privateReviewFile(@Req() req: any, @Param('workspaceId') workspaceId: string, @Param('siteId') siteId: string, @Param('id') id: string, @Param('index') index: string, @Res() res: any) {
    if (!/^(0|[1-9][0-9]*)$/.test(index)) { res.status(404).set('Cache-Control','private, no-store').json({message:'Private record unavailable'}); return; }
    const bytes = await this.rssd.privateReview.file(req.rssd, workspaceId, siteId, id, Number(index));
    res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="private-evidence.bin"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"}).send(bytes);
  }
  @Get('/health') health(@Req() req: any) { return health(this.rssd.store, req.rssd); }
  @Get('/labels') labels(@Req() req: any) { return this.rssd.labels.feed(req.rssd); }
  @Get('/community') community(@Req() req: any) { return this.rssd.community.status(req.rssd); }
  @Get('/guestbooks') guestbooks(@Req() req: any) { return this.rssd.guestbook.books(req.rssd); }
  @Get('/guestbooks/:siteId/messages') guestbookMessages(@Req() req: any, @Param('siteId') siteId: string, @Query('status') status: string) { return this.rssd.guestbook.moderation(req.rssd, siteId, status); }
  @Post('/guestbooks/:siteId/messages/:id/review') reviewGuestbook(@Req() req: any, @Param('siteId') siteId: string, @Param('id') id: string, @Body() body: any) { return this.rssd.guestbook.review(req.rssd, siteId, id, body.status); }
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
  @Get('/editorial/:workspaceId/{*path}') editorialRead(@Req() req: any, @Param('workspaceId') workspaceId: string, @Param('path') path: string[], @Query() query: any) { return this.rssd.editorial.api(req.rssd, workspaceId, 'GET', path, query); }
  @Post('/editorial/:workspaceId/{*path}') editorialWrite(@Req() req: any, @Param('workspaceId') workspaceId: string, @Param('path') path: string[], @Query() query: any, @Body() body: any) { return this.rssd.editorial.api(req.rssd, workspaceId, 'POST', path, query, body); }
}
