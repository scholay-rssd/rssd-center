'use strict';
// RSSD protocol v1. MIT. Kept independent of GUI, server, and agent dependencies.
const crypto = require('node:crypto');
const VERSION = 1;
class ProtocolError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new ProtocolError(message, status, code); };
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function text(value, name, max = 10000, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || value.includes('\0')) fail(`Invalid ${name}`);
  return value;
}
function id(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) fail(`Invalid ${name}`);
  return value;
}
function locale(value) {
  if (!['zh-CN', 'en'].includes(value)) fail('Unsupported locale');
  return value;
}
function array(value, name, max = 100) {
  if (!Array.isArray(value) || value.length > max) fail(`Invalid ${name}`);
  return value;
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function publicUrl(value, name = 'url') {
  const raw = text(value, name, 4096); let url;
  try { url = new URL(raw); } catch { fail(`Invalid ${name}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`Invalid ${name}`);
  return raw;
}
function json(value, name, max = 100000) {
  object(value, name); const raw = JSON.stringify(value);
  if (raw.length > max) fail(`${name} is too large`);
  return JSON.parse(raw);
}
function policy(input) {
  const value = object(input, 'policy');
  const targets = array(value.targets || [], 'targets', 100).map(target => ({
    destinationId: id(target.destinationId, 'destinationId'), locale: locale(target.locale),
  }));
  if (new Set(targets.map(t => t.destinationId + ':' + t.locale)).size !== targets.length) fail('Duplicate publication target');
  return {version: integer(value.version ?? 1, 'policy.version', 1),
    instructions: text(value.instructions ?? '', 'instructions', 100000, true),
    brand: json(value.brand || {}, 'brand'), targets};
}
function workspace(input) {
  const value = object(input, 'workspace');
  const sections = array(value.sections, 'sections').map(section => ({id: id(section.id, 'sectionId'),
    name: text(section.name, 'section name', 200), policy: policy(section.policy || {targets: []})}));
  if (!sections.length || new Set(sections.map(s => s.id)).size !== sections.length) fail('Sections must be nonempty and unique');
  return {id: id(value.id, 'workspaceId'), name: text(value.name, 'workspace name', 200),
    siteId: value.siteId ? id(value.siteId, 'siteId') : null, sections};
}
function demand(input) {
  const value = object(input, 'demand');
  const kind = value.kind || 'write'; if (!['write', 'translate', 'update'].includes(kind)) fail('Invalid demand kind');
  const requiredLocales = [...new Set(array(value.requiredLocales || ['zh-CN', 'en'], 'requiredLocales', 2).map(locale))];
  if (!requiredLocales.length) fail('At least one locale is required');
  const source = value.source == null ? null : {workId: id(value.source.workId, 'source.workId'),
    locale: locale(value.source.locale), revision: integer(value.source.revision, 'source.revision', 1)};
  if (kind !== 'write' && !source) fail('Translation and update demands require a source edition');
  return {id: value.id ? id(value.id) : crypto.randomUUID(), workspaceId: id(value.workspaceId, 'workspaceId'),
    sectionId: id(value.sectionId, 'sectionId'), kind, title: text(value.title, 'title', 500),
    brief: text(value.brief ?? '', 'brief', 100000, true), requiredLocales, source,
    priority: integer(value.priority ?? 0, 'priority', -100, 100)};
}
function edition(input) {
  const value = object(input, 'edition');
  const sources = array(value.sources || [], 'sources', 500).map(source => ({
    title: text(source.title || '', 'source title', 1000, true), url: publicUrl(source.url),
  }));
  const media = array(value.media || [], 'media', 500).map(item => ({
    id: id(item.id, 'mediaId'), alt: text(item.alt || '', 'media alt', 2000, true),
  }));
  const translationOf = value.translationOf == null ? null : {workId: id(value.translationOf.workId),
    locale: locale(value.translationOf.locale), revision: integer(value.translationOf.revision, 'translation revision', 1)};
  return {locale: locale(value.locale), title: text(value.title, 'edition title', 1000),
    bodyMarkdown: text(value.bodyMarkdown, 'bodyMarkdown', 2000000),
    summary: text(value.summary || '', 'summary', 10000, true), sources, media,
    metadata: json(value.metadata || {}, 'metadata', 2000000), translationOf};
}
function submission(input) {
  const value = object(input, 'submission');
  const editions = array(value.editions, 'editions', 2).map(edition);
  if (!editions.length || new Set(editions.map(e => e.locale)).size !== editions.length) fail('Editions must be nonempty and unique');
  const baseRevisions = object(value.baseRevisions || {}, 'baseRevisions');
  const bases = Object.fromEntries(editions.map(e => [e.locale, integer(baseRevisions[e.locale] ?? 0, 'baseRevision')]));
  if (Boolean(value.demandId) !== Boolean(value.claimToken)) fail('demandId and claimToken must be provided together');
  return {requestId: id(value.requestId, 'requestId'), workId: id(value.workId, 'workId'),
    workspaceId: id(value.workspaceId, 'workspaceId'), sectionId: id(value.sectionId, 'sectionId'),
    demandId: value.demandId ? id(value.demandId, 'demandId') : null,
    claimToken: value.claimToken ? id(value.claimToken, 'claimToken') : null,
    baseRevisions: bases, editions};
}
module.exports = {VERSION, ProtocolError, fail, object, text, id, locale, array, integer, canonical, hash,
  publicUrl, json, policy, workspace, demand, edition, submission};
