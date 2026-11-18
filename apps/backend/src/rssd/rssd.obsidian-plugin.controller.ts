import { Controller, Get, Header, Param, HttpException, Req, Res } from '@nestjs/common';
const { PluginReleases } = require('../../../../rssd/obsidian-plugin-releases.cjs');

// Public GET-only surface for the signed RSSD Obsidian plugin release and its
// files, built from public repositories. It holds no credentials or workspace
// data, and a vault installs a release only when its signature verifies
// against the key compiled into the plugin it already runs.
const reply = (e: any) => e?.status && e?.code
  ? { status: e.status, body: { message: e.message, code: e.code } }
  : { status: 503, body: { message: 'The plugin release is unavailable', code: 'plugin_release_unavailable' } };

@Controller('/rssd/public/v1/obsidian-plugin')
export class RssdObsidianPluginController {
  private readonly releases = new PluginReleases();
  @Get('/latest')
  @Header('Cache-Control', 'no-store')
  async latest() {
    try { return await this.releases.latest(); }
    catch (e: any) { const { status, body } = reply(e); throw new HttpException(body, status); }
  }
  @Get('/files/:sha256')
  async file(@Param('sha256') sha256: string, @Req() req: any, @Res() res: any) {
    try {
      const file = await this.releases.raw(sha256, req.headers['if-none-match']);
      res.status(file.status).set(file.headers);
      return file.body ? res.end(file.body) : res.end();
    } catch (e: any) { const { status, body } = reply(e); res.status(status).json(body); }
  }
}
