import { Controller, Get, Header, Param, HttpException, Res } from '@nestjs/common';
const { PluginReleases } = require('../../../../rssd/obsidian-plugin-releases.cjs');

// Public GET-only surface for the signed RSSD Obsidian plugin release and its
// files, built from public repositories. It holds no credentials or workspace
// data, and a vault installs a release only when its signature verifies
// against the key compiled into the plugin it already runs.
@Controller('/rssd/public/v1/obsidian-plugin')
export class RssdObsidianPluginController {
  private readonly releases = new PluginReleases();
  @Get('/latest')
  @Header('Cache-Control', 'no-store')
  async latest() {
    try { return await this.releases.latest(); }
    catch (e: any) { throw new HttpException({ message: e.message, code: e.code }, e.status || 503); }
  }
  @Get('/files/:sha256')
  async file(@Param('sha256') sha256: string, @Res() res: any) {
    try {
      const bytes = await this.releases.file(sha256);
      res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=31536000, immutable' }).end(bytes);
    } catch (e: any) { res.status(e.status || 503).json({ message: e.message, code: e.code }); }
  }
}
