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
  const result = {version: integer(value.version ?? 1, 'policy.version', 1),
    instructions: text(value.instructions ?? '', 'instructions', 100000, true),
    brand: json(value.brand || {}, 'brand'), targets};
  // The persona that signs this section's new works: its ID and the name printed as the byline. Being
  // part of the policy, it is frozen with a claim like every other rule. A section without one keeps the
  // site's own byline. Nothing else about a persona belongs here.
  if (value.persona != null) result.persona = persona(value.persona);
  // How a work of this section gets the persona that writes it, and whose name it is signed with. It
  // replaces `persona`, so a section has one or the other. See docs/persona-voice.md.
  if (value.voice != null) {
    if (value.persona != null) fail('A section has a persona byline or a voice, not both');
    result.voice = voice(value.voice);
  }
  return result;
}
// A section's voice. `mode` says who picks the persona of a new work: `fixed` names one; `choose` lets the
// writer pick among candidates; `random` and `balanced` let the Center draw. Every mode but `fixed` picks
// from `range`, which is 'all' or a list of persona IDs, and may name a `fallback` for when nothing in the
// range can be used. `byline` says whose name signs: the persona's founder ('persona') or the site ('site').
// The same lists are VOICE_MODES and VOICE_BYLINES in persona-voice.mjs, which a test keeps equal.
const VOICE_MODES = ['fixed', 'choose', 'random', 'balanced'], VOICE_BYLINES = ['persona', 'site'];
function presetId(value, field) {
  if (typeof value !== 'string' || !/^P\d{4,}$/.test(value)) fail('Invalid ' + field + ': expected a P preset ID');
  return id(value, field);
}
function voice(input) {
  const value = object(input, 'voice'), byline = value.byline ?? 'persona';
  if (!VOICE_MODES.includes(value.mode)) fail('Invalid voice.mode');
  if (!VOICE_BYLINES.includes(byline)) fail('Invalid voice.byline');
  if (value.mode === 'fixed') {
    if (value.range != null || value.fallback != null) fail('A fixed voice names one persona and nothing else');
    return {mode: 'fixed', persona: presetId(value.persona, 'voice.persona'), byline};
  }
  if (value.persona != null) fail('Only a fixed voice names its persona');
  let range = 'all';
  if (value.range != null && value.range !== 'all') {
    range = array(value.range, 'voice.range', 500).map(item => presetId(item, 'voice.range'));
    if (!range.length || new Set(range).size !== range.length) fail('voice.range must be nonempty and unique');
  }
  return {mode: value.mode, range, ...(value.fallback != null ? {fallback: presetId(value.fallback, 'voice.fallback')} : {}), byline};
}
function persona(input) {
  const value = object(input, 'persona'), name = text(value.name, 'persona.name', 80);
  if (name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) fail('Invalid persona.name');
  return {id: id(value.id, 'persona.id'), name};
}
function workspace(input) {
  const value = object(input, 'workspace');
  const sections = array(value.sections, 'sections').map(section => ({id: id(section.id, 'sectionId'),
    name: text(section.name, 'section name', 200), policy: policy(section.policy || {targets: []})}));
  if (!sections.length || new Set(sections.map(s => s.id)).size !== sections.length) fail('Sections must be nonempty and unique');
  return {id: id(value.id, 'workspaceId'), name: text(value.name, 'workspace name', 200),
    siteId: value.siteId ? id(value.siteId, 'siteId') : null, sections};
}
// The work types a demand may ask for: CHOSEN_WORK_TYPES in work-types.mjs, which a test keeps equal.
const DEMAND_WORK_TYPES = ['article', 'note'];
function demand(input) {
  const value = object(input, 'demand');
  const kind = value.kind || 'write'; if (!['write', 'translate', 'update'].includes(kind)) fail('Invalid demand kind');
  const requiredLocales = [...new Set(array(value.requiredLocales || ['zh-CN', 'en'], 'requiredLocales', 2).map(locale))];
  if (!requiredLocales.length) fail('At least one locale is required');
  const source = value.source == null ? null : {workId: id(value.source.workId, 'source.workId'),
    locale: locale(value.source.locale), revision: integer(value.source.revision, 'source.revision', 1)};
  if (kind !== 'write' && !source) fail('Translation and update demands require a source edition');
  const result = {id: value.id ? id(value.id) : crypto.randomUUID(), workspaceId: id(value.workspaceId, 'workspaceId'),
    sectionId: id(value.sectionId, 'sectionId'), kind, title: text(value.title, 'title', 500),
    brief: text(value.brief ?? '', 'brief', 100000, true), requiredLocales, source,
    priority: integer(value.priority ?? 0, 'priority', -100, 100)};
  // Optional, and absent from a demand that states none, so earlier demands keep their identity: the type of
  // work asked for, the article a note is to be rewritten from, the subject key used to notice a repeat, and
  // the lead that prompted the topic.
  if (value.workType != null) {
    if (!DEMAND_WORK_TYPES.includes(value.workType)) fail('Invalid work type');
    if (kind !== 'write') fail('Only a write demand chooses a work type');
    result.workType = value.workType;
  }
  if (value.adaptedFrom != null) {
    if (result.workType !== 'note') fail('Only a note can be rewritten from an article');
    const from = object(value.adaptedFrom, 'adaptedFrom');
    result.adaptedFrom = {workId: id(from.workId, 'adaptedFrom.workId'), revision: integer(from.revision, 'adaptedFrom.revision', 1)};
  }
  if (value.topicKey != null) result.topicKey = text(value.topicKey, 'topicKey', 200);
  // An order may name the persona that writes it, or ask for none, whatever the section's voice says.
  // A note rewritten from an article keeps the article's persona, so it cannot name another.
  if (value.voice != null) {
    if (kind !== 'write') fail('Only a write demand names its persona');
    if (result.adaptedFrom) fail('A note rewritten from an article keeps the persona of the article');
    result.voice = value.voice === 'none' ? 'none' : {persona: presetId(object(value.voice, 'voice').persona, 'voice.persona')};
  }
  // What prompted the topic, such as a hot-board term: who reported it, what it said and when it was seen.
  // A lead only suggests a topic. It is never evidence and never a source of the article.
  if (value.lead != null) {
    if (kind !== 'write') fail('Only a write demand records a lead');
    const lead = object(value.lead, 'lead'), seen = typeof lead.observedAt === 'string' ? Date.parse(lead.observedAt) : NaN;
    if (!Number.isFinite(seen)) fail('Invalid lead.observedAt');
    result.lead = {provider: id(lead.provider, 'lead.provider'), ...(lead.platformId != null ? {platformId: id(lead.platformId, 'lead.platformId')} : {}),
      term: text(lead.term, 'lead.term', 200), observedAt: new Date(seen).toISOString(), ...(lead.url != null ? {url: publicUrl(lead.url, 'lead.url')} : {})};
  }
  return result;
}
const MEDIA_REF = /(?:https?:\/\/[^/\s)"']+)?\/api\/rssd\/v1\/media\/([a-zA-Z0-9._:-]+)\/raw/g;
function referencedMediaIds(markdown) {
  return [...new Set(String(markdown || '').matchAll(MEDIA_REF).map(match => match[1]))];
}
function edition(input) {
  const value = object(input, 'edition');
  const sources = array(value.sources || [], 'sources', 500).map(source => ({
    title: text(source.title || '', 'source title', 1000, true), url: publicUrl(source.url),
  }));
  const media = array(value.media || [], 'media', 500).map(item => ({
    id: id(item.id, 'mediaId'), alt: text(item.alt || '', 'media alt', 2000, true),
  }));
  for (const mediaId of referencedMediaIds(value.bodyMarkdown)) {
    if (!media.some(item => item.id === mediaId)) fail('Article references media missing from its edition manifest', 400, 'missing_media');
  }
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
  publicUrl, json, policy, persona, voice, VOICE_MODES, VOICE_BYLINES, workspace, demand, DEMAND_WORK_TYPES, referencedMediaIds, edition, submission};
