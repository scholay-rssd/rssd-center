'use client';
// The works library and the language editor, as a tab of the work centre.
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { ApiError, type RssdApi } from './api';
import { PlatformContent } from './platform-content';
import { useShellMode } from './mode';
import './center-admin.css';

const Editor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });
type Row = Record<string, any>;
export type DemandSource = { workspaceId: string; sectionId: string; title: string; kind: 'translate' | 'update'; source: { workId: string; locale: string; revision: number } };
const when = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export function WorksPanel({ api, registry, initialWorkspace, onDeriveDemand }: { api: RssdApi; registry: Row[]; initialWorkspace?: string; onDeriveDemand: (source: DemandSource) => void }) {
  const user = useUser(), [mode] = useShellMode();
  const [space, setSpace] = useState(initialWorkspace || ''), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [listing, setListing] = useState<{ key: string; rows: Row[] }>({ key: '', rows: [] }), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null), [language, setLanguage] = useState('zh-CN'), [title, setTitle] = useState(''), [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Row[]>([]), [platformContent, setPlatformContent] = useState<Row>({});
  const [pending, setPending] = useState<Row | null>(null), [conflict, setConflict] = useState<Row | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Row>>({}), [draftsLoaded, setDraftsLoaded] = useState(false);
  const generation = useRef(0);
  // Keep a legacy link's workspace when it is available to this account.
  useEffect(() => {
    if (space && registry.length && !registry.some(workspace => workspace.id === space)) {
      setSpace(''); setOffset(0); setNotice('指定工作空间不可用，已显示当前账号的授权范围。');
    }
  }, [registry, space]);
  const listKey = JSON.stringify([space, search, offset]);
  // A filter changes before its request finishes. Never show another filter's rows.
  const rows = listing.key === listKey ? listing.rows : [], listLoading = loading || listing.key !== listKey;
  const active = registry.find(w => w.id === space), writable = active?.writable !== false;
  const editing = registry.find(w => w.id === selected?.workspaceId), editable = editing?.writable !== false;
  const storageKey = 'rssd:pending:' + user?.orgId, draftKey = 'rssd:editor-drafts:' + user?.orgId;
  const locked = busy || Boolean(pending);
  const refresh = useCallback(async () => {
    const id = ++generation.current; setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '50', offset: String(offset) }); if (space) query.set('workspaceId', space); if (search) query.set('search', search);
      const result = await api('/works?' + query);
      if (id === generation.current) setListing({ key: listKey, rows: result });
    } catch (err) { if (id === generation.current) setError((err as Error).message); }
    finally { if (id === generation.current) setLoading(false); }
  }, [api, space, search, offset, listKey]);
  useEffect(() => { const timeout = setTimeout(refresh, 180); return () => { clearTimeout(timeout); generation.current++; }; }, [refresh]);
  useEffect(() => { setDraftsLoaded(false); try { const saved = localStorage.getItem(draftKey); setDrafts(saved ? JSON.parse(saved) : {}); const queued = localStorage.getItem(storageKey) || sessionStorage.getItem(storageKey); setPending(queued ? JSON.parse(queued) : null); setDraftsLoaded(true); } catch { setError('无法读取此浏览器保存的草稿，请检查浏览器存储。'); } }, [storageKey, draftKey]);
  useEffect(() => {
    if (!selected || !draftsLoaded) return;
    const key = selected.id + ':' + language, value = { selected, language, title, body, attachments, platformContent, savedAt: new Date().toISOString() };
    setDrafts(old => { const next = { ...old, [key]: value }; try { localStorage.setItem(draftKey, JSON.stringify(next)); } catch { setError('浏览器草稿存储已满，请下载原稿或保存到中心后继续。'); } return next; });
  }, [selected, language, title, body, attachments, platformContent, draftKey, draftsLoaded]);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const fill = (edition?: Row) => { setTitle(edition?.payload.title || ''); setBody(edition?.payload.bodyMarkdown || ''); setAttachments(edition?.payload.media || []); setPlatformContent(edition?.payload.metadata?.platformContent || {}); };
  const restoreDraft = (saved: Row) => { setSelected(saved.selected); setLanguage(saved.language); setTitle(saved.title); setBody(saved.body); setAttachments(saved.attachments || []); setPlatformContent(saved.platformContent || saved.selected.editions.find((e: Row) => e.locale === saved.language)?.payload.metadata?.platformContent || {}); setCreating(false); setSpace(saved.selected.workspaceId); };
  const openWork = async (id: string) => {
    setConflict(null);
    const work = await api('/works/' + encodeURIComponent(id)), saved = drafts[id + ':' + language];
    if (saved) { restoreDraft(saved); setNotice('已恢复此浏览器的草稿；保存时仍会校验原基础版本。'); return; }
    setSelected(work); setCreating(false);
    const edition = work.editions.find((e: Row) => e.locale === language) || work.editions[0];
    setLanguage(edition?.locale || 'zh-CN'); fill(edition);
  };
  const discardSavedDraft = (workId: string, locale: string) => setDrafts(old => { const next = { ...old }; delete next[workId + ':' + locale]; localStorage.setItem(draftKey, JSON.stringify(next)); return next; });
  const chooseLanguage = (locale: string) => {
    const saved = drafts[selected?.id + ':' + locale]; if (saved) { restoreDraft(saved); return; }
    setLanguage(locale); fill(selected?.editions.find((e: Row) => e.locale === locale));
  };
  const rememberPending = (value: Row | null) => { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); sessionStorage.removeItem(storageKey); setPending(value); };
  const accepted = async (result: Row) => { rememberPending(null); discardSavedDraft(result.workId, language); setNotice(result.status === 'draft_saved' ? '草稿已保存' : '作品已接收，发布结果可在“发布日历”查看'); setSelected(await api('/works/' + encodeURIComponent(result.workId))); await refresh(); };
  const sendEdition = async (publish: boolean) => {
    if (!selected) return;
    const previous = selected.editions.find((e: Row) => e.locale === language);
    const packet = { requestId: crypto.randomUUID(), workId: selected.id, workspaceId: selected.workspaceId, sectionId: selected.sectionId,
      baseRevisions: { [language]: previous?.revision || 0 }, editions: [{ ...(previous?.payload || {}), locale: language, title, bodyMarkdown: body, media: attachments, metadata: { ...previous?.payload.metadata, platformContent } }] };
    const request = { path: publish ? '/submissions' : '/drafts', packet }; rememberPending(request);
    try { await accepted(await api(request.path, 'POST', packet)); }
    catch (err) { if (err instanceof ApiError && err.status < 500) rememberPending(null); if (err instanceof ApiError && err.code === 'revision_conflict') setConflict(await api('/works/' + encodeURIComponent(selected.id))); throw err; }
  };
  const recover = async () => {
    if (!pending) return;
    try { await accepted(await api('/submissions/' + encodeURIComponent(pending.packet.requestId))); }
    catch (err) { if (err instanceof ApiError && err.status === 404) await accepted(await api(pending.path, 'POST', pending.packet)); else throw err; }
  };
  const newWork = (form: HTMLFormElement) => {
    const values = new FormData(form); setSelected({ id: crypto.randomUUID(), workspaceId: space, sectionId: values.get('section'), editions: [] });
    setLanguage(values.get('language') as string); fill(); setCreating(false);
  };
  const deriveDemand = (kind: 'translate' | 'update') => { const edition = selected?.editions.find((e: Row) => e.locale === language); if (!selected || !edition) return; onDeriveDemand({ workspaceId: selected.workspaceId, sectionId: selected.sectionId, title: edition.payload.title, kind, source: { workId: selected.id, locale: language, revision: edition.revision } }); };
  const upload = async (file: File) => {
    if (!selected) return; if (file.size > 20 * 1024 * 1024) throw Error('配图不能超过 20 MiB');
    const bytes = await file.arrayBuffer(), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('图片读取失败')); reader.readAsDataURL(file); });
    const result = await api('/media', 'POST', { workspaceId: selected.workspaceId, sha256, mime: file.type, bytes: file.size, data, name: file.name });
    setAttachments(old => [...old.filter(m => m.id !== result.id), { id: result.id, alt: file.name }]); setBody(old => old + '\n\n![' + file.name.replace(/[\[\]\\\n\r]/g, ' ') + '](' + result.url + ')\n'); setNotice('配图已保存到中心，保存文章后会保留引用');
  };
  const savedDrafts = Object.entries(drafts).filter(([, d]) => !space || d.selected.workspaceId === space);
  const stored = selected?.editions.find((e: Row) => e.locale === language);
  return <section className="ca-panel" aria-label="作品库">
    {!selected && <div className="cp-section-heading"><div><h2>作品库</h2><p>作品由执行设备交稿，也可以在这里创建和修改；每种语言各有版本。</p></div>
      <button className="cp-primary" disabled={locked || !space || !writable} title={!space ? '先选择工作空间' : undefined} onClick={() => { setCreating(true); setError(''); setNotice(''); }}>新建作品</button></div>}
    {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
    {notice && <p role="status" className="cp-notice">{notice}</p>}
    {pending && <p role="status" className="cp-notice">{busy ? '正在提交，原稿与请求已保留。' : '上次提交的结果尚未确认，原稿与请求已保留。'}<button disabled={busy} onClick={() => void action(recover)}>查询并恢复原提交</button></p>}
    {!selected && <>
      <div className="cp-filter-row">
        <label className="ca-inline">工作空间<select aria-label="工作空间" disabled={locked} value={space} onChange={e => { setSpace(e.target.value); setOffset(0); setCreating(false); }}><option value="">全部工作空间</option>{registry.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="cp-search"><input aria-label="查找作品" type="search" placeholder="作品标题或正文" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} /></label>
      </div>
      {active && !writable && <p className="cp-notice">此站点已导入，正在核对迁移。完成旧系统交接后才能在中心创建和提交作品。</p>}
      {creating && active && <form className="ca-form ca-card" onSubmit={event => { event.preventDefault(); newWork(event.currentTarget); }}>
        <h3>创建一件作品</h3>
        <label>栏目<select name="section" required>{active.sections.map((s: Row) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>首先编辑的语言<select name="language"><option value="zh-CN">中文</option><option value="en">English</option></select></label>
        <div className="ca-actions"><button type="button" onClick={() => setCreating(false)}>取消</button><button className="cp-primary">创建</button></div>
      </form>}
      {savedDrafts.length > 0 && <details className="ca-card"><summary>此浏览器保留的草稿</summary>{savedDrafts.map(([id, d]) => <p key={id}><button className="cp-text-button" onClick={() => restoreDraft(d)}>{d.title || '未命名作品'} · {d.language}</button><span className="cp-muted"> {when(d.savedAt)}</span></p>)}</details>}
      <div className="cp-table-wrap" aria-busy={listLoading}>
        <table className="cp-demands-table">
          <thead><tr><th>作品</th><th>语言与版本</th><th>工作空间</th><th>最近更新</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td><button className="cp-task-title" disabled={locked} onClick={() => void action(() => openWork(row.id))}>{row.editions[0]?.title || '未命名作品'}</button></td>
            <td>{row.editions.map((e: Row) => `${e.locale} · v${e.revision}`).join(' / ')}</td>
            <td>{registry.find(w => w.id === row.workspaceId)?.name || row.workspaceId}</td>
            <td><time>{when(row.updatedAt || row.createdAt)}</time></td>
          </tr>)}</tbody>
        </table>
        {!rows.length && <div className="cp-empty"><h3>{listLoading ? '正在读取…' : '还没有作品'}</h3><p>作品可以从执行设备提交，也可以在这里创建。</p></div>}
      </div>
      <div className="ca-actions ca-pager"><button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button disabled={loading || rows.length < 50} onClick={() => setOffset(offset + 50)}>下一页</button></div>
    </>}
    {selected && <div className="ca-editor">
      <div className="ca-toolbar">
        <button disabled={locked} onClick={() => setSelected(null)}>返回作品库</button>
        <div className="cp-view-switch"><button disabled={locked} aria-pressed={language === 'zh-CN'} onClick={() => chooseLanguage('zh-CN')}>中文</button><button disabled={locked} aria-pressed={language === 'en'} onClick={() => chooseLanguage('en')}>English</button></div>
        <span className="cp-muted ca-grow">{editing?.name || selected.workspaceId} · 版本 {stored?.revision || 0}</span>
        <button disabled={locked || !editable || !title.trim() || !body.trim()} onClick={() => void action(() => sendEdition(false))}>保存草稿</button>
        <button className="cp-primary" disabled={locked || !editable || !title.trim() || !body.trim()} onClick={() => void action(() => sendEdition(true))}>提交发布</button>
      </div>
      {conflict?.id === selected.id && <div className="cp-notice ca-stack"><strong>中心已有更新，你的修改仍保留在下方编辑器。</strong><p>请先对照中心版本合并修改，再选择“已合并”，随后保存或提交。</p>
        <details><summary>查看中心当前版本</summary><h3>{conflict.editions.find((e: Row) => e.locale === language)?.payload.title}</h3><textarea aria-label="中心当前正文" readOnly rows={12} value={conflict.editions.find((e: Row) => e.locale === language)?.payload.bodyMarkdown || ''} /></details>
        <button onClick={() => { setSelected(conflict); setConflict(null); setNotice('已采用中心当前版本作为基础，下方修改仍保留，请保存或提交。'); }}>已合并，以中心当前版本为基础保存</button></div>}
      <input className="ca-title" aria-label="文章标题" placeholder="文章标题" value={title} onChange={e => setTitle(e.target.value)} disabled={locked} />
      {/* The editor picks its syntax colours from this attribute. */}
      <div data-color-mode={mode}><Editor value={body} onChange={value => setBody(value || '')} height={560} previewOptions={{ skipHtml: true }} textareaProps={{ 'aria-label': '文章正文', disabled: locked }} /></div>
      <div className="ca-toolbar">
        <label className="ca-inline">插入配图<input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(() => upload(file)); }} /></label>
        <span className="ca-grow" />
        <button disabled={!editable || busy || !stored} onClick={() => deriveDemand('translate')}>创建翻译需求</button>
        <button disabled={!editable || busy || !stored} onClick={() => deriveDemand('update')}>创建补充更新需求</button>
      </div>
      <p className="ca-note">编辑内容会保留在此浏览器，提交后同步到中心。</p>
      <PlatformContent api={api} workspaceId={selected.workspaceId} value={platformContent} onChange={setPlatformContent} attachments={attachments} disabled={locked} />
    </div>}
  </section>;
}
