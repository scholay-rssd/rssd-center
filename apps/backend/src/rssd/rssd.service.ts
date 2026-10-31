import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
// The versioned domain runtime is packaged into dist/rssd by the backend build.
const { RssdStore } = require('../../../../rssd/store.cjs');
const { RssdPublisher } = require('../../../../rssd/publisher.cjs');
const { RssdMedia } = require('../../../../rssd/media.cjs');

@Injectable()
export class RssdService implements OnModuleInit, OnModuleDestroy {
  readonly store: any;
  readonly publisher: any;
  readonly media: any;
  private timer?: ReturnType<typeof setInterval>;
  constructor(prisma: PrismaService) {
    this.store = new RssdStore(prisma);
    this.media = new RssdMedia(this.store, {directory: process.env.RSSD_MEDIA_DIRECTORY, origin: process.env.FRONTEND_URL});
    this.publisher = new RssdPublisher(this.store, {secret: process.env.RSSD_ENCRYPTION_KEY || process.env.JWT_SECRET, media: this.media});
  }
  onModuleInit() {
    if (process.env.RSSD_DISPATCH_ENABLED === '1') this.timer = setInterval(() => {
      this.publisher.tick().catch(() => console.error('RSSD publisher could not access its queue'));
    }, 3000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
