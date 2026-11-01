import { Injectable, OnModuleInit, OnModuleDestroy, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import { organizationId, postId } from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
// The versioned domain runtime is packaged into dist/rssd by the backend build.
const { RssdCoordination } = require('../../../../rssd/coordination.cjs');
const { RssdMcp } = require('../../../../rssd/mcp.cjs');
const { RssdStore } = require('../../../../rssd/store.cjs');
const { DeviceAuthorization } = require('../../../../rssd/device-auth.cjs');
const { RssdPublisher } = require('../../../../rssd/publisher.cjs');
const { RssdMedia } = require('../../../../rssd/media.cjs');
const { RssdPostiz } = require('../../../../rssd/postiz.cjs');
const { RssdGuestbook } = require('../../../../rssd/guestbook.cjs');
const { RssdLabels } = require('../../../../rssd/labels.cjs');
const { RssdCommunity } = require('../../../../rssd/community.cjs');
const { RssdEditorial } = require('../../../../rssd/editorial.cjs');
const { RssdEditorialActions } = require('../../../../rssd/editorial-actions.cjs');
const { RssdPrivateReview } = require('../../../../rssd/private-review.cjs');
const { PrivateImportOutcome } = require('../../../../rssd/private-import-outcome.cjs');
const { PrivateImportOwner } = require('../../../../rssd/private-import-owner.mjs');
const { createPrivateImportSocket } = require('../../../../rssd/private-import-socket.mjs');
const { runPrivateImportProbe, boundedSocket } = require('../../../../rssd/private-import-startup.mjs');
const { readPrivateImportSecrets } = require('../../../../rssd/private-import-secrets.mjs');
const { SecurePrivateImport } = require('../../../../rssd/private-import-secure-adapter.mjs');

@Injectable()
export class RssdService implements OnModuleInit, OnModuleDestroy {
  readonly store: any;
  readonly coordination: any;
  readonly mcp: any;
  private coordinationTimer?: ReturnType<typeof setInterval>;
  readonly authorization: any;
  readonly publisher: any;
  readonly media: any;
  readonly postiz: any;
  readonly guestbook: any;
  readonly labels = new RssdLabels();
  readonly community: any;
  readonly editorial: any;
  readonly privateReview: any;
  readonly privateImportOutcome: any;
  privateImport: any = null;
  private importEnabled = false;
  private importGeneration = 0;
  private importAbort?: AbortController;
  private importProbe = runPrivateImportProbe;
  private importStartupTimeoutMs = 8000;
  private importStatus: 'disabled' | 'initializing' | 'ready' | 'unavailable' = 'disabled';
  private importPrisma?: any;
  private importSourcePrisma?: any;
  private importIssuerPrisma?: any;
  private importSocket?: any;
  private timer?: ReturnType<typeof setInterval>;
  constructor(prisma: PrismaService, posts: PostsService, temporal: TemporalService) {
    this.store = new RssdStore(prisma);
    this.privateReview = new RssdPrivateReview(this.store);
    this.privateImportOutcome = new PrivateImportOutcome(this.store);
    this.importEnabled = process.env.RSSD_PRIVATE_IMPORT_ENABLED === '1';
    this.importStatus = this.importEnabled ? 'initializing' : 'disabled';
    this.coordination = new RssdCoordination(this.store);
    this.mcp = new RssdMcp(this.store, this.coordination);
    this.authorization = new DeviceAuthorization(this.store, {verifyOwner: async (orgId: string, userId: string) =>
      (await prisma.$queryRawUnsafe('SELECT id FROM "UserOrganization" WHERE "organizationId"=$1 AND "userId"=$2 AND disabled=false AND role IN (\'ADMIN\',\'SUPERADMIN\')',orgId,userId) as any[]).length>0});
    this.community = new RssdCommunity(this.store);
    this.guestbook = new RssdGuestbook(this.store, {secret: process.env.RSSD_ENCRYPTION_KEY || process.env.JWT_SECRET});
    this.media = new RssdMedia(this.store, {directory: process.env.RSSD_MEDIA_DIRECTORY, origin: process.env.FRONTEND_URL});
    this.editorial = new RssdEditorial(this.store, this.media);
    this.postiz = new RssdPostiz(this.store, {
      validate: (org: string, values: any[]) => posts.validatePosts(org, values),
      uploadMedia: async ({bytes, asset}: any) => UploadFactory.createStorage().uploadFile({buffer: bytes, mimetype: asset.manifest.mime, originalname: asset.name} as Express.Multer.File),
      workflowStatus: async (id: string) => {
        const client = temporal.client.getRawClient();
        if (!client) throw new Error('Temporal is unavailable');
        try { const info = await client.workflow.getHandle(id).describe(); return {runId: info.runId, status: info.status.name}; }
        catch (error: any) { if (error.name === 'WorkflowNotFoundError') return null; throw error; }
      },
      startWorkflow: async (input: any) => {
        const client = temporal.client.getRawClient();
        if (!client) throw new Error('Temporal is unavailable');
        const handle = await client.workflow.start('postWorkflowV112', {
          workflowId: input.workflowId, taskQueue: 'main', workflowIdConflictPolicy: 'USE_EXISTING', workflowIdReusePolicy: 'REJECT_DUPLICATE',
          args: [{taskQueue: input.taskQueue, postId: input.postId, organizationId: input.organizationId}],
          typedSearchAttributes: new TypedSearchAttributes([{key: postId, value: input.postId}, {key: organizationId, value: input.organizationId}]),
        });
        return {runId: handle.firstExecutionRunId};
      },
    });
    this.publisher = new RssdPublisher(this.store, {secret: process.env.RSSD_ENCRYPTION_KEY || process.env.JWT_SECRET, media: this.media, postiz: this.postiz});
    this.editorial.actions = new RssdEditorialActions(this.store, this.media, this.publisher, this.editorial);
  }
  onModuleInit() {
    if (this.importEnabled) {
      this.importAbort?.abort();
      const generation = ++this.importGeneration, controller = new AbortController();
      this.importAbort = controller;
      void this.initializePrivateImport(generation, controller.signal);
    }
    if (process.env.RSSD_GOAL_MAINTENANCE_ENABLED === '1') this.coordinationTimer = setInterval(() => {
      this.coordination.tick().catch(() => console.error('RSSD goal maintenance unavailable'));
    }, 60000);
    if (process.env.RSSD_DISPATCH_ENABLED === '1') this.timer = setInterval(() => {
      this.publisher.tick().catch(() => console.error('RSSD publisher could not access its queue'));
      this.editorial.actions.tick().catch(() => console.error('RSSD website actions could not access their queue'));
    }, 3000);
  }
  private async initializePrivateImport(generation: number, signal: AbortSignal) {
    try {
      const {worker,source,issuer} = await readPrivateImportSecrets(process.env,{signal,timeoutMs:this.importStartupTimeoutMs});
      if (signal.aborted || generation !== this.importGeneration) return;
      const socketPath = process.env.RSSD_PRIVATE_IMPORT_SOCKET;
      if (!worker || !source || !issuer || !socketPath) throw new Error('Private import role configuration is required');
      await this.importProbe({worker,source,issuer},{signal,timeoutMs:this.importStartupTimeoutMs});
      if (signal.aborted || generation !== this.importGeneration) return;
      const { PrismaClient } = require('@prisma/client');
      this.importPrisma = new PrismaClient({datasources:{db:{url:worker}}});
      this.importSourcePrisma = new PrismaClient({datasources:{db:{url:source}}});
      this.importIssuerPrisma = new PrismaClient({datasources:{db:{url:issuer}}});
      const socket = await boundedSocket(()=>createPrivateImportSocket({socketPath,service:new SecurePrivateImport(this.importSourcePrisma,this.importPrisma,{sourceUrl:source}),onFailure:()=>{if(generation===this.importGeneration)void this.disablePrivateImport();}}),{signal,timeoutMs:this.importStartupTimeoutMs});
      if (signal.aborted || generation !== this.importGeneration) { await socket.close(); return; }
      this.importSocket = socket;
      this.privateImport = new PrivateImportOwner(this.importIssuerPrisma,{onFailure:()=>{if(generation===this.importGeneration)void this.disablePrivateImport();}});
      this.importStatus = 'ready';
    } catch {
      if (generation === this.importGeneration) await this.disablePrivateImport();
    }
  }
  private async disablePrivateImport(report = true) {
    ++this.importGeneration;
    this.importAbort?.abort(); this.importAbort = undefined;
    this.privateImport = null;
    this.importStatus = report ? 'unavailable' : 'disabled';
    const socket = this.importSocket, worker = this.importPrisma, source = this.importSourcePrisma, issuer = this.importIssuerPrisma;
    this.importSocket = undefined; this.importPrisma = undefined; this.importSourcePrisma = undefined; this.importIssuerPrisma = undefined;
    await Promise.allSettled([socket?.close(), worker?.$disconnect(), source?.$disconnect(), issuer?.$disconnect()]);
    if (report) console.error('RSSD private import unavailable');
  }
  privateImportStatus(ctx: any) {
    if (!ctx?.admin || !ctx.userId || ctx.workerId) throw new ForbiddenException();
    return {state: this.importStatus};
  }
  async onModuleDestroy() { if (this.coordinationTimer) clearInterval(this.coordinationTimer); if (this.timer) clearInterval(this.timer); await this.disablePrivateImport(false); this.labels.close(); await this.community.close(); }
}
