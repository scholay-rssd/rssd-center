'use client';
// Channel configuration and account connection for the 发布渠道 tab.
// Destinations are this Center's own records (/rssd/v1/destinations). Social
// accounts are authorized by the application's integrations API; only the
// screens around that sign-in are ours.
import { useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Drawer } from './view/center/preview/parts';
import { platformImage } from './view/center/preview/assets';
import type { RssdApi } from './api';
import './center-admin.css';

type Row = Record<string, any>;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Add or edit a destination. `initial.id` empty means a new one. */
export function DestinationDrawer({ api, workspaces, destinationId, onClose, onSaved }: { api: RssdApi; workspaces: Row[]; destinationId?: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [selected, setSelected] = useState<Row | null>(destinationId ? null : { id: '', kind: 'site', workspaceIds: [], config: {} });
  const [channels, setChannels] = useState<Row[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api('/channels').then(value => { if (live) setChannels(value); }).catch(e => { if (live) setError(message(e)); });
    if (destinationId) api('/destinations').then(rows => { if (live) setSelected(rows.find((r: Row) => r.id === destinationId) || null); if (live && !rows.some((r: Row) => r.id === destinationId)) setError('找不到这个发布渠道，请刷新后重试。'); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [api, destinationId]);
  return <Drawer title={destinationId ? '发布渠道设置' : '添加发布渠道'} onClose={onClose}>
    <div className="cp-detail-body">
      {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
      {!selected && !error && <p className="cp-muted">正在读取…</p>}
      {selected && <form className="cp-detail-form ca-form" key={selected.id || selected.kind} autoComplete="off" onSubmit={event => {
        event.preventDefault(); const v = new FormData(event.currentTarget); setBusy(true); setError('');
        api('/destinations', 'POST', { id: selected.id || v.get('id'), name: v.get('name'), kind: selected.kind, workspaceIds: v.getAll('workspaces'), config: selected.kind === 'postiz' ? { integrationId: selected.config.integrationId || v.get('integrationId') } : { origin: selected.config.origin || v.get('origin'), ...(selected.kind === 'discourse' ? { username: selected.config.username || v.get('username'), categoryId: Number(selected.config.categoryId || v.get('categoryId')) } : { siteId: selected.config.siteId || v.get('siteId') }) }, token: v.get('token') || undefined, enabled: v.get('enabled') === 'on' })
          .then(onSaved).then(onClose).catch(e => setError(message(e))).finally(() => setBusy(false));
      }}>
        <h2>{selected.id ? selected.name : '添加发布渠道'}</h2>
        <p className="cp-muted">渠道决定作品发到哪里；每个栏目发哪些语言到哪个渠道，在“设置 · 工作空间”的栏目规则中选择。</p>
        <label>渠道类型<select disabled={Boolean(selected.id)} value={selected.kind} onChange={e => setSelected({ ...selected, kind: e.target.value, config: {} })}><option value="site">自家站点</option><option value="discourse">Discourse 论坛</option><option value="postiz">已连接的社交账号</option></select></label>
        <label>连接名称<input name="name" required defaultValue={selected.name} /></label>
        <label>连接标识<input name="id" required disabled={Boolean(selected.id)} defaultValue={selected.id} /></label>
        {selected.kind === 'postiz'
          ? <label>社交账号<select name="integrationId" required disabled={Boolean(selected.id)} defaultValue={selected.config.integrationId || ''}><option value="">选择账号</option>{channels.map(c => <option key={c.id} value={c.id}>{c.name} · {c.providerIdentifier}{c.disabled ? '（停用）' : c.refreshNeeded ? '（需要重新授权）' : ''}</option>)}</select></label>
          : <>
            <label>站点网址<input type="url" name="origin" required disabled={Boolean(selected.id)} defaultValue={selected.config.origin} /></label>
            {selected.kind === 'site'
              ? <label>站点标识<input name="siteId" required disabled={Boolean(selected.id)} defaultValue={selected.config.siteId} /></label>
              : <><label>论坛发布用户名<input name="username" required disabled={Boolean(selected.id)} defaultValue={selected.config.username} /></label><label>论坛分类编号<input type="number" min="1" name="categoryId" required disabled={Boolean(selected.id)} defaultValue={selected.config.categoryId} /></label></>}
            <label>{selected.kind === 'discourse' ? '论坛 API Key' : '站点接收凭据'}<input type="password" name="token" required={!selected.hasCredential} placeholder={selected.hasCredential ? '留空保留已有凭据' : ''} autoComplete="new-password" /></label>
          </>}
        <fieldset><legend>允许发布的工作空间</legend>{workspaces.map(w => <label className="ca-check" key={w.id}><input type="checkbox" name="workspaces" value={w.id} defaultChecked={selected.workspaceIds.includes(w.id)} />{w.name}</label>)}</fieldset>
        <label className="ca-check"><input type="checkbox" name="enabled" defaultChecked={selected.enabled} />启用此渠道的内容发布</label>
        <footer><button className="cp-primary" disabled={busy}>保存连接</button></footer>
      </form>}
    </div>
  </Drawer>;
}

/** Connect a new social account, or look after the ones already connected. */
export function AccountsDrawer({ focusId, onClose, onChanged }: { focusId?: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const fetch = useFetch();
  const [accounts, setAccounts] = useState<Row[] | null>(null), [providers, setProviders] = useState<Row[] | null>(null), [fields, setFields] = useState<Row | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
  const request = async (path: string, init?: RequestInit) => { const response = await fetch(path, init); const value = await response.json().catch(() => ({})); if (!response.ok) throw Error(value.message || '操作失败'); return value; };
  useEffect(() => {
    let live = true;
    request('/integrations/list').then(value => { if (live) setAccounts(value.integrations || []); }).catch(e => { if (live) setError(message(e)); });
    request('/integrations').then(value => { if (live) setProviders(value.social || []); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [tick]);
  const run = (work: () => Promise<unknown>) => { setBusy(true); setError(''); work().catch(e => setError(message(e))).finally(() => setBusy(false)); };
  // The platform's sign-in page takes over the window and returns here when it is done.
  const authorize = (identifier: string, query = '', data?: Row) => run(async () => {
    const { url, err } = await request('/integrations/social/' + encodeURIComponent(identifier) + query);
    if (err || !url) throw Error('无法连接这个平台，请稍后重试。');
    window.location.href = data ? '/integrations/social/' + encodeURIComponent(identifier) + '?state=' + encodeURIComponent(url) + '&code=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(data))))) : url;
  });
  const toggle = (account: Row) => run(async () => { await request('/integrations/' + (account.disabled ? 'enable' : 'disable'), { method: 'POST', body: JSON.stringify({ id: account.id }) }); setTick(n => n + 1); await onChanged(); });
  const simple = (p: Row) => !p.isExternal && !p.isWeb3 && !p.isChromeExtension;
  return <Drawer title="社交账号" onClose={onClose}>
    <div className="cp-detail-body">
      <h2>已连接的账号</h2>
      <p className="cp-muted">授权在各平台自己的登录页完成，完成后回到这里。账号连接后，还要添加为发布渠道才会接收作品。</p>
      {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
      {!accounts ? <p className="cp-muted">正在读取…</p> : !accounts.length ? <p className="cp-muted">还没有连接任何社交账号。</p> : accounts.map(a => <article className={'ca-item' + (a.id === focusId ? ' ca-focus' : '')} key={a.id}>
        <div><strong>{platformImage(a.identifier) && <img src={platformImage(a.identifier)} alt="" draggable={false} />}{a.name}</strong><small>{a.identifier}{a.disabled ? ' · 已停用' : a.refreshNeeded ? ' · 需要重新授权' : a.inBetweenSteps ? ' · 授权未完成' : ' · 已连接'}</small></div>
        <button disabled={busy} onClick={() => authorize(a.identifier, '?refresh=' + encodeURIComponent(a.internalId))}>重新授权</button>
        <button disabled={busy} onClick={() => toggle(a)}>{a.disabled ? '启用' : '停用'}</button>
      </article>)}
      <h3>连接新的账号</h3>
      {fields ? <form className="cp-detail-form ca-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget), values: Row = {}; for (const f of fields.customFields) values[f.key] = String(form.get(f.key) || ''); authorize(fields.identifier, '', values); }}>
        <p className="cp-muted">{fields.name}</p>
        {fields.customFields.map((f: Row) => <label key={f.key}>{f.label}<input name={f.key} type={f.type === 'password' ? 'password' : 'text'} required defaultValue={f.defaultValue || ''} autoComplete="off" />{f.hint && <small>{f.hint}</small>}</label>)}
        <footer><button type="button" disabled={busy} onClick={() => setFields(null)}>返回</button><button className="cp-primary" disabled={busy}>连接</button></footer>
      </form> : !providers ? <p className="cp-muted">正在读取…</p> : <div className="ca-providers">
        {providers.filter(simple).map(p => <button key={p.identifier} disabled={busy} title={p.toolTip || undefined} onClick={() => p.customFields ? setFields(p) : authorize(p.identifier)}>{platformImage(p.identifier) && <img src={platformImage(p.identifier)} alt="" draggable={false} />}{p.name}</button>)}
      </div>}
      {providers && providers.some(p => !simple(p)) && <p className="ca-note">未列出：{providers.filter(p => !simple(p)).map(p => p.name).join('、')}。这些平台需要浏览器扩展或钱包签名，暂不能在这里连接。</p>}
    </div>
  </Drawer>;
}
