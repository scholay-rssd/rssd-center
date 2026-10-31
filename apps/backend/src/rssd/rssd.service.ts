import { Injectable } from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
// The versioned domain runtime is packaged into dist/rssd by the backend build.
const { RssdStore } = require('../../../../rssd/store.cjs');

@Injectable()
export class RssdService {
  readonly store: any;
  constructor(prisma: PrismaService) { this.store = new RssdStore(prisma); }
}
