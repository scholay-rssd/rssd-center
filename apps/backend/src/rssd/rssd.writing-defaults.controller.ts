import { Controller, Get, Header, Param, HttpException } from '@nestjs/common';
const { WritingDefaults } = require('../../../../rssd/writing-defaults.cjs');

// This public GET-only surface contains exactly the reviewed public rule
// catalog. It has no credentials, personal preferences or organizational data.
@Controller('/rssd/public/v1/writing-defaults')
export class RssdWritingDefaultsController {
  private readonly rules = new WritingDefaults();
  private async read(workspaceId?: string, sectionId?: string) {
    try { return workspaceId ? await this.rules.resolve(workspaceId, sectionId) : await this.rules.catalog(); }
    catch (e: any) { throw new HttpException({message:e.message,code:e.code},e.status||503); }
  }
  @Get()
  @Header('Cache-Control','no-store')
  catalog() { return this.read(); }
  @Get('/:workspaceId/:sectionId')
  @Header('Cache-Control','no-store')
  section(@Param('workspaceId') workspaceId: string, @Param('sectionId') sectionId: string) { return this.read(workspaceId,sectionId); }
}
