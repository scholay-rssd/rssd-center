'use strict';
const p = require('./protocol.cjs');
const {resolveArticleId} = require('./existing-site-publish.cjs');

const MAX_RECIPE_BYTES = 2 * 1024 * 1024;
function sha(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) p.fail('Invalid ' + name);
  return value;
}

// Pixels and reproducible layouts share the same immutable source identity.
// Layout strings are inert export data. Consumers must sandbox any HTML rendering.
function rendition(input) {
  p.object(input, 'rendition');
  if (input.schemaVersion !== 1 || input.format !== 'cards') p.fail('Unsupported rendition');
  const source = p.object(input.source, 'source');
  const engine = p.object(input.engine, 'engine');
  const value = {
    schemaVersion: 1, format: 'cards',
    workspaceId: p.id(input.workspaceId), workId: p.id(input.workId),
    locale: p.locale(input.locale),
    source: {revision: p.integer(source.revision, 'revision', 1),
      editionHash: sha(source.editionHash, 'edition hash'), hash: sha(source.hash, 'render source hash')},
    variant: p.id(input.variant, 'variant'),
    engine: {name: p.text(engine.name, 'engine name', 100), version: p.text(engine.version, 'engine version', 100)},
    width: p.integer(input.width, 'width', 1, 8192), height: p.integer(input.height, 'height', 1, 8192),
    coverMediaId: input.coverMediaId == null ? null : p.id(input.coverMediaId),
    representation: input.representation,
  };
  if (source.articleId !== undefined || source.siteId !== undefined) {
    value.source.articleId = p.id(source.articleId, 'source article');
    value.source.siteId = p.id(source.siteId, 'source site');
  }
  const pages = p.array(input.pages, 'pages', 500);
  if (!pages.length) p.fail('A rendition needs pages');
  if (value.representation === 'raster') {
    value.pages = pages.map(page => ({mediaId: p.id(p.object(page, 'page').mediaId)}));
  } else if (value.representation === 'layout') {
    value.css = p.text(input.css, 'CSS', 100000, true);
    value.pages = pages.map(page => ({html: p.text(p.object(page, 'page').html, 'page HTML', 200000)}));
    value.mediaIds = [...new Set(p.array(input.mediaIds || [], 'layout media', 500).map(id => p.id(id)))].sort();
    // Embedded images defeat content addressing and duplicate the image on every page.
    if (/data\s*:/i.test(value.css + value.pages.map(page => page.html).join(''))) p.fail('Use referenced media instead of data URLs');
    const content = value.css + value.pages.map(page => page.html).join('');
    if (/\/article-media\//.test(content)) p.fail('Resolve layout images to workspace media IDs');
    for (const id of p.referencedMediaIds(content)) {
      if (!value.mediaIds.includes(id)) p.fail('Layout references unregistered media', 409, 'missing_media');
    }
  } else p.fail('Unsupported representation');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RECIPE_BYTES) p.fail('Rendition exceeds 2 MiB', 413, 'rendition_limit');
  return value;
}

function mediaIds(value) {
  return [...new Set([value.coverMediaId, ...(value.mediaIds || []),
    ...value.pages.map(page => page.mediaId)].filter(Boolean))];
}

class RssdRenditions {
  constructor(store) { this.store = store; }

  async source(db, ctx, workspaceId, workId, locale, revision) {
    const {row} = await this.store.workspace(db, ctx, p.id(workspaceId));
    const siteId = row.payload.siteId || workspaceId;
    const editions = await db.$queryRawUnsafe(`SELECT e.hash, e.payload->>'title' AS title, w."sectionId",
      COALESCE(l.source->'document'->>'kind', e.payload->'metadata'->'record'->>'kind', 'news') AS kind,
      COALESCE(l."documentId", e.payload->'metadata'->'editorial'->>'documentId') AS "documentId",
      COALESCE((jsonb_path_query_first(l.source->'revisions', '$[*] ? (@.version == $revision)',
        jsonb_build_object('revision', e.revision))->>'payload')::jsonb->>'id',
        e.payload->'metadata'->'editorial'->>'articleId', (l.source->'revisions'->-1->>'payload')::jsonb->>'id') AS "articleId"
      FROM rssd_editions e JOIN rssd_works w ON w."orgId"=e."orgId" AND w.id=e."workId"
      LEFT JOIN rssd_legacy_documents l ON l."orgId"=e."orgId" AND l."workId"=e."workId" AND l.locale=e.locale AND l."siteId"=$6
      WHERE e."orgId"=$1 AND w."workspaceId"=$2 AND e."workId"=$3 AND e.locale=$4 AND e.revision=$5`,
    ctx.orgId, workspaceId, p.id(workId), p.locale(locale), p.integer(revision, 'revision', 1), siteId);
    if (!editions.length) p.fail('Source edition not found', 404, 'not_found');
    if (editions.length !== 1) p.fail('Ambiguous source edition', 409, 'identity_conflict');
    const edition = editions[0];
    const metadata = {record: {kind: edition.kind}, editorial: {articleId: edition.articleId, documentId: edition.documentId}};
    return {workspaceId, siteId, workId, locale, revision, hash: edition.hash,
      articleId: resolveArticleId(workId, locale, {metadata}), title: edition.title, kind: edition.kind, sectionId: edition.sectionId};
  }

  async save(ctx, workspaceId, input) {
    const value = rendition(input);
    if (value.workspaceId !== workspaceId) p.fail('Rendition workspace mismatch');
    const id = 'rendition-' + p.hash(value);
    return this.store.transaction(async db => {
      const edition = await this.source(db, ctx, workspaceId, value.workId, value.locale, value.source.revision);
      await this.store.writable(db, ctx, workspaceId);
      if (ctx.workerId) {
        const workers = await db.$queryRawUnsafe('SELECT id FROM rssd_workers WHERE "orgId"=$1 AND id=$2 AND "revokedAt" IS NULL', ctx.orgId, ctx.workerId);
        if (!workers.length) p.fail('Device revoked', 401);
      }
      if (edition.hash !== value.source.editionHash) p.fail('Source edition hash mismatch', 409, 'source_conflict');
      if (!value.source.articleId) {
        const existing = await db.$queryRawUnsafe('SELECT id FROM rssd_renditions WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=$3', ctx.orgId, workspaceId, id);
        if (existing.length) return {id, workspaceId, source: value.source};
        p.fail('Prepare the export again with its source article and site', 409, 'identity_conflict');
      }
      if (edition.articleId !== value.source.articleId || edition.siteId !== value.source.siteId) p.fail('Source article or site mismatch', 409, 'identity_conflict');
      const ids = mediaIds(value);
      const assets = await db.$queryRawUnsafe('SELECT id,manifest FROM rssd_media WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=ANY($3::text[])', ctx.orgId, workspaceId, ids);
      if (assets.length !== ids.length) p.fail('Upload all referenced media in this workspace first', 409, 'missing_media');
      const assetBytes = assets.reduce((total, asset) => total + asset.manifest.bytes, 0);
      const cover = assets.find(asset => asset.id === value.coverMediaId);
      const summary = {id, workId: value.workId, locale: value.locale, source: value.source,
        variant: value.variant, representation: value.representation, title: edition.title,
        kind: edition.kind, sectionId: edition.sectionId, pageCount: value.pages.length,
        width: value.width, height: value.height, assetBytes,
        recipeBytes: Buffer.byteLength(JSON.stringify(value)),
        cover: cover ? {mediaId: cover.id, bytes: cover.manifest.bytes,
          url: '/api/rssd/v1/media/' + cover.id + '/raw'} : null};
      await db.$executeRawUnsafe(`INSERT INTO rssd_renditions
        ("orgId",id,"workspaceId","workId",locale,revision,variant,summary,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
        ON CONFLICT ("orgId",id) DO NOTHING`, ctx.orgId, id, workspaceId, value.workId,
      value.locale, value.source.revision, value.variant, JSON.stringify(summary), JSON.stringify(value));
      await db.$executeRawUnsafe(`INSERT INTO rssd_rendition_media ("orgId","renditionId","mediaId")
        SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`, ctx.orgId, id, ids);
      return {id, workspaceId, source: value.source};
    });
  }

  async detail(ctx, workspaceId, id) {
    await this.store.workspace(this.store.db, ctx, p.id(workspaceId));
    const [row] = await this.store.db.$queryRawUnsafe('SELECT payload FROM rssd_renditions WHERE "orgId"=$1 AND "workspaceId"=$2 AND id=$3', ctx.orgId, workspaceId, p.id(id));
    if (!row) p.fail('Rendition not found', 404, 'not_found');
    return {id, ...row.payload};
  }

  async list(ctx, workspaceId, {after = '', limit = 40, workId, locale = 'zh-CN'} = {}) {
    await this.store.workspace(this.store.db, ctx, p.id(workspaceId));
    p.locale(locale);
    if (after) p.id(after);
    if (workId !== undefined) p.id(workId);
    if (typeof limit === 'string' && /^[1-9][0-9]*$/.test(limit)) limit = Number(limit);
    p.integer(limit, 'limit', 1, 100);
    const params = [ctx.orgId, workspaceId, locale, after, limit + 1];
    let filter = '';
    if (workId !== undefined) { params.push(workId); filter = 'AND r."workId"=$6'; }
    // The covering scope indexes bound the rows before any edition lookup or JSON read.
    const rows = await this.store.db.$queryRawUnsafe(`SELECT r.id,r.summary,
      (r.revision=(SELECT max(e.revision) FROM rssd_editions e
        WHERE e."orgId"=r."orgId" AND e."workId"=r."workId" AND e.locale=r.locale)) AS current
      FROM rssd_renditions r WHERE r."orgId"=$1 AND r."workspaceId"=$2 AND r.locale=$3
      AND r.id>$4 ${filter} ORDER BY r.id LIMIT $5`, ...params);
    const items = rows.slice(0, limit).map(row => ({...row.summary, current: row.current}));
    return {items, next: rows.length > limit ? items.at(-1).id : null};
  }
}

module.exports = {RssdRenditions, rendition, mediaIds};
