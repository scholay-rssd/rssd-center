'use strict';
const p = require('./protocol.cjs');
const q = (db, sql, ...args) => db.$queryRawUnsafe(sql, ...args);
function manifest(input) {
  p.object(input, 'rendition');
  const value = {
    format: 'cards', workId: p.id(input.workId), locale: p.locale(input.locale),
    revision: p.integer(input.revision, 'revision', 1),
    sourceHash: p.text(input.sourceHash, 'source hash', 64),
    method: p.text(input.method, 'method', 30), title: p.text(input.title, 'title', 500),
    cover: p.id(input.cover), pages: p.array(input.pages, 'pages', 999).map(id => p.id(id)),
  };
  if (!/^[a-f0-9]{64}$/.test(value.sourceHash)) p.fail('Invalid source hash');
  if (!['algorithm','intelligent','image'].includes(value.method)) p.fail('Invalid card method');
  if (!value.pages.length) p.fail('Card set must contain pages');
  return value;
}
class RssdRenditions {
  constructor(store, media) { this.store = store; this.media = media; }
  async save(ctx, workspaceId, input) {
    p.id(workspaceId);
    const value = manifest(input);
    await this.store.workspace(this.store.db, ctx, workspaceId);
    let bytes = 0;
    for (const id of new Set([...value.pages, value.cover])) {
      const row = await this.media.row(ctx, id);
      if (row.workspaceId !== workspaceId) p.fail('Media belongs to another workspace', 403);
      if (row.manifest.mime !== 'image/webp') p.fail('Card pages must be WebP');
      bytes += row.manifest.bytes;
    }
    const id = 'cards-' + p.hash([workspaceId, value]);
    return this.store.transaction(async db => {
      await this.store.workspace(db, ctx, workspaceId);
      if (ctx.workerId && !(await q(db, 'SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL', ctx.orgId, ctx.workerId)).length) p.fail('Device revoked', 401);
      const source = (await q(db, 'SELECT e.hash,w."sectionId" FROM rssd_editions e JOIN rssd_works w ON w."orgId"=e."orgId" AND w.id=e."workId" WHERE e."orgId"=$1 AND w."workspaceId"=$2 AND e."workId"=$3 AND e.locale=$4 AND e.revision=$5', ctx.orgId, workspaceId, value.workId, value.locale, value.revision))[0];
      if (!source || source.hash !== value.sourceHash) p.fail('Source revision mismatch', 409, 'source_conflict');
      await db.$executeRawUnsafe('INSERT INTO rssd_renditions ("orgId",id,"workspaceId","workId",locale,revision,"sectionId",method,title,cover,"pageCount",bytes,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT ("orgId",id) DO NOTHING', ctx.orgId,id,workspaceId,value.workId,value.locale,value.revision,source.sectionId,value.method,value.title,value.cover,value.pages.length,bytes,JSON.stringify(value));
      return {id, pageCount: value.pages.length, bytes};
    });
  }
  async list(ctx, workspaceId, query = {}) {
    await this.store.workspace(this.store.db, ctx, p.id(workspaceId));
    const limit = query.limit === undefined ? 30 : p.integer(Number(query.limit), 'limit', 1, 100);
    const after = query.after === undefined ? '' : p.id(query.after);
    const rows = await q(this.store.db, 'SELECT r.id,r."workId",r.locale,r.revision,r."sectionId",r.method,r.title,r.cover,r."pageCount",r.bytes,r."createdAt", (r.revision = (SELECT max(e.revision) FROM rssd_editions e WHERE e."orgId"=r."orgId" AND e."workId"=r."workId" AND e.locale=r.locale)) AS current FROM rssd_renditions r WHERE r."orgId"=$1 AND r."workspaceId"=$2 AND r.id>$3 ORDER BY r.id LIMIT $4', ctx.orgId, workspaceId, after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({...row, bytes: Number(row.bytes)}));
    return {items, next: rows.length > limit ? items.at(-1).id : null};
  }
  async detail(ctx, workspaceId, id) {
    await this.store.workspace(this.store.db, ctx, p.id(workspaceId));
    const row = (await q(this.store.db, 'SELECT id,payload FROM rssd_renditions WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=$3', ctx.orgId, workspaceId, p.id(id)))[0];
    if (!row) p.fail('Card set not found', 404, 'not_found');
    return {id: row.id, ...row.payload};
  }
}
module.exports = {RssdRenditions, manifest};
