import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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
const { RssdMigration } = require('../../../../rssd/migration.cjs');

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
  readonly migration: any;
  private timer?: ReturnType<typeof setInterval>;
  constructor(prisma: PrismaService, posts: PostsService, temporal: TemporalService) {
    this.store = new RssdStore(prisma);
    this.coordination = new RssdCoordination(this.store);
    this.mcp = new RssdMcp(this.store, this.coordination);
    this.authorization = new DeviceAuthorization(this.store, {verifyOwner: async (orgId: string, userId: string) =>
      (await prisma.$queryRawUnsafe('SELECT id FROM "UserOrganization" WHERE "organizationId"=$1 AND "userId"=$2 AND disabled=false AND role IN (\'ADMIN\',\'SUPERADMIN\')',orgId,userId) as any[]).length>0});
    this.community = new RssdCommunity(this.store);
    this.guestbook = new RssdGuestbook(this.store, {secret: process.env.RSSD_ENCRYPTION_KEY || process.env.JWT_SECRET});
    this.media = new RssdMedia(this.store, {directory: process.env.RSSD_MEDIA_DIRECTORY, origin: process.env.FRONTEND_URL});
    this.migration = new RssdMigration(this.store, this.media);
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
    if (process.env.RSSD_GOAL_MAINTENANCE_ENABLED === '1') this.coordinationTimer = setInterval(() => {
      this.coordination.tick().catch(() => console.error('RSSD goal maintenance unavailable'));
    }, 60000);
    if (process.env.RSSD_DISPATCH_ENABLED === '1') this.timer = setInterval(() => {
      this.publisher.tick().catch(() => console.error('RSSD publisher could not access its queue'));
      this.editorial.actions.tick().catch(() => console.error('RSSD website actions could not access their queue'));
    }, 3000);
  }
  async onModuleDestroy() { if (this.coordinationTimer) clearInterval(this.coordinationTimer); if (this.timer) clearInterval(this.timer); this.labels.close(); await this.community.close(); }
}
