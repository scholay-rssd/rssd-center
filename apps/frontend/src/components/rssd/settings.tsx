'use client';
// The settings tab of the work centre: devices, workspaces, health,
// guestbook review, labels and the signed-in account.
import { useCallback, useEffect, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Drawer } from './view/center/preview/parts';
import type { RssdApi } from './api';
import { WorkspacePolicy } from './configuration';
import { CenterHealth } from './health';
import { GuestbookModeration } from './guestbook';
import { CenterLabels } from './labels';
import './center-admin.css';

type Row = Record<string, any>;
export const settingsSections = [['devices', '执行设备'], ['workspaces', '工作空间'], ['health', '运行状况'], ['guestbooks', '留言审核'], ['labels', '流量标签'], ['account', '账号']] as const;
export type SettingsSection = typeof settingsSections[number][0];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stateNames: Record<string, string> = { idle: '空闲', running: '工作中', paused: '已暂停', revoked: '已撤销' };
const when = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未连接';

function Devices({ api, registry }: { api: RssdApi; registry: Row[] }) {
  const [rows, setRows] = useState<Row[] | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false), [token, setToken] = useState(''), [grantFor, setGrantFor] = useState<Row | null>(null), [destinations, setDestinations] = useState<Row[]>([]);
  const load = useCallback(() => api('/workers').then(setRows), [api]);
  useEffect(() => { load().catch(e => setError(message(e))); }, [load]);
  const action = (work: () => Promise<unknown>) => { setBusy(true); setError(''); setNotice(''); work().catch(e => setError(message(e))).finally(() => setBusy(false)); };
  return <section aria-label="执行设备">
    <div className="cp-section-heading"><div><h2>执行设备</h2><p>连接凭据按工作空间授权，智能体账号留在设备上。设备失联后保留原认领，由你恢复或释放。</p></div>
      <button className="cp-primary" disabled={busy} onClick={() => { setConnecting(true); setToken(''); }}>连接设备</button></div>
    {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
    {notice && <p role="status" className="cp-notice">{notice}</p>}
    <div className="cp-table-wrap">
      <table className="cp-demands-table">
        <thead><tr><th>设备</th><th>状态</th><th>工作空间</th><th>最后连接</th><th>操作</th></tr></thead>
        <tbody>{(rows || []).map(row => <tr key={row.id}>
          <td><strong>{row.name}</strong>{row.details?.message && <small>{row.details.message}</small>}</td>
          <td><span className="cp-state">{row.revokedAt ? '已撤销' : stateNames[row.state] || row.state}</span></td>
          <td>{row.workspaceIds.map((id: string) => registry.find(w => w.id === id)?.name || id).join('、')}</td>
          <td><time>{when(row.heartbeatAt)}</time></td>
          <td>{!row.revokedAt && <span className="ca-row-actions">
            <button className="cp-text-button" disabled={busy} onClick={() => action(async () => { setDestinations(await api('/destinations')); setGrantFor(row); })}>授予排期</button>
            <button className="cp-text-button" disabled={busy} onClick={() => action(async () => { await api('/workers/' + row.id + '/revoke', 'POST', {}); await load(); })}>撤销连接</button>
          </span>}</td>
        </tr>)}</tbody>
      </table>
      {rows && !rows.length && <div className="cp-empty"><h3>尚未连接执行设备</h3><p>在无头执行端或桌面端填入连接凭据后，设备会出现在这里。</p></div>}
      {!rows && !error && <div className="cp-empty"><h3>正在读取…</h3></div>}
    </div>
    {connecting && <Drawer title="连接设备" onClose={() => setConnecting(false)}>
      <div className="cp-detail-body">
        <h2>为执行设备生成连接凭据</h2>
        {token ? <>
          <p className="cp-notice"><strong>连接凭据只显示这一次。</strong></p>
          <p className="cp-muted">复制到对应设备的 RSSD 中心设置中。</p>
          <input aria-label="设备连接凭据" readOnly type="password" value={token} />
          <div className="ca-actions"><button onClick={() => void navigator.clipboard.writeText(token).then(() => setNotice('连接凭据已复制')).catch(() => setError('复制失败，请选择后复制'))}>复制凭据</button><button className="cp-primary" onClick={() => { setToken(''); setConnecting(false); }}>完成</button></div>
        </> : <form className="cp-detail-form ca-form" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); action(async () => { const worker = await api('/workers', 'POST', { name: values.get('name'), workspaceIds: values.getAll('spaces') }); setToken(worker.token); await load(); }); }}>
          <label>设备名称<input name="name" required placeholder="例如：Mac mini" /></label>
          <fieldset><legend>允许处理的工作空间</legend>{registry.map(w => <label className="ca-check" key={w.id}><input type="checkbox" name="spaces" value={w.id} />{w.name}</label>)}</fieldset>
          <footer><button className="cp-primary" disabled={busy}>生成凭据</button></footer>
        </form>}
      </div>
    </Drawer>}
    {grantFor && <Drawer title="授予排期权限" onClose={() => setGrantFor(null)}>
      <form className="cp-detail-body cp-detail-form ca-form" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); action(async () => { await api('/workers/' + grantFor.id + '/grants', 'POST', { requestId: crypto.randomUUID(), operation: 'publicationScheduling', workspaceIds: values.getAll('spaces'), destinationIds: values.getAll('destinations') }); setGrantFor(null); setNotice('已授予最小排期范围。设备不会成为管理员；源码改动不会自动授权线上设备。'); }); }}>
        <h2>{grantFor.name}</h2>
        <p className="cp-muted">仅 Owner 可授予和撤销。必须显式选择工作空间和目的地。设备不能自行提权，也不会获得 admin 身份。</p>
        <fieldset><legend>工作空间</legend>{grantFor.workspaceIds.map((id: string) => <label className="ca-check" key={id}><input type="checkbox" name="spaces" value={id} defaultChecked />{registry.find(w => w.id === id)?.name || id}</label>)}</fieldset>
        <fieldset><legend>目的地</legend>{destinations.filter(d => d.workspaceIds?.some((id: string) => grantFor.workspaceIds.includes(id))).map(d => <label className="ca-check" key={d.id}><input type="checkbox" name="destinations" value={d.id} />{d.name}</label>)}</fieldset>
        <footer><button className="cp-primary" disabled={busy}>授予</button></footer>
      </form>
    </Drawer>}
  </section>;
}

function Workspaces({ api, registry, reload }: { api: RssdApi; registry: Row[]; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState(''), [creating, setCreating] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const active = registry.find(w => w.id === selected);
  return <section aria-label="工作空间">
    <div className="cp-section-heading"><div><h2>工作空间</h2><p>每个工作空间对应一个站点及其栏目。栏目规则决定写作要求和发布到哪些渠道。</p></div>
      <button className="cp-primary" disabled={busy} onClick={() => setCreating(true)}>新建工作空间</button></div>
    {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
    {notice && <p role="status" className="cp-notice">{notice}</p>}
    {!active && <div className="cp-table-wrap">
      <table className="cp-demands-table">
        <thead><tr><th>工作空间</th><th>栏目</th><th>站点</th><th>操作</th></tr></thead>
        <tbody>{registry.map(w => <tr key={w.id}>
          <td><strong>{w.name}</strong><small>{w.id}{w.writable === false ? ' · 迁移核对中' : ''}</small></td>
          <td>{w.sections.map((s: Row) => s.name).join(' · ')}</td>
          <td>{w.siteId || '尚未关联站点'}</td>
          <td><button className="cp-text-button" onClick={() => { setSelected(w.id); setNotice(''); }}>栏目规则</button></td>
        </tr>)}</tbody>
      </table>
      {!registry.length && <div className="cp-empty"><h3>还没有工作空间</h3></div>}
    </div>}
    {active && <><div className="ca-toolbar"><button onClick={() => setSelected('')}>返回工作空间列表</button></div><WorkspacePolicy key={active.id} workspace={active} api={api} onSaved={reload} /></>}
    {creating && <Drawer title="新建工作空间" onClose={() => setCreating(false)}>
      <form className="cp-detail-body cp-detail-form ca-form" onSubmit={event => {
        event.preventDefault(); const values = new FormData(event.currentTarget), id = String(values.get('id')); setBusy(true); setError('');
        api('/workspaces', 'POST', { baseRevision: 0, workspace: { id, name: values.get('name'), siteId: values.get('siteId') || null, sections: [{ id: values.get('sectionId'), name: values.get('sectionName'), policy: { version: 1, instructions: values.get('instructions') || '', targets: [] } }] } })
          .then(async () => { await reload(); setCreating(false); setSelected(id); setNotice('工作空间已建立，可配置栏目与发布渠道后投入生产'); }).catch(e => setError(message(e))).finally(() => setBusy(false));
      }}>
        <h2>建立工作空间</h2>
        <label>名称<input name="name" required /></label>
        <label>稳定标识<input name="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._:-]*" /></label>
        <label>对应站点标识<input name="siteId" /></label>
        <label>首个栏目名称<input name="sectionName" required /></label>
        <label>首个栏目标识<input name="sectionId" required /></label>
        <label>写作要求<textarea name="instructions" rows={5} /></label>
        {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
        <footer><button className="cp-primary" disabled={busy}>创建</button></footer>
      </form>
    </Drawer>}
  </section>;
}

function Account() {
  const user = useUser(), fetch = useFetch(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const logout = () => { setBusy(true); setError(''); fetch('/user/logout', { method: 'POST' }).then(() => { window.location.href = '/'; }).catch(e => { setError(message(e)); setBusy(false); }); };
  return <section aria-label="账号">
    <div className="cp-section-heading"><div><h2>账号</h2><p>这个中心只有负责人一个账号。执行设备使用各自的连接凭据，不使用账号密码。</p></div></div>
    {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
    <dl className="cp-facts ca-facts"><dt>登录邮箱</dt><dd>{user?.email || '—'}</dd><dt>组织编号</dt><dd>{user?.orgId || '—'}</dd></dl>
    <div className="ca-toolbar"><button disabled={busy} onClick={logout}>退出登录</button></div>
  </section>;
}

export function SettingsPanel({ api, registry, reloadRegistry, initialSection = 'devices', workspaceId }: { api: RssdApi; registry: Row[]; reloadRegistry: () => Promise<void>; initialSection?: SettingsSection; workspaceId?: string }) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  return <section className="ca-panel" aria-label="设置">
    <div className="cp-filter-row"><div className="cp-state-filters" aria-label="设置分类">{settingsSections.map(([id, name]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}</div></div>
    {section === 'devices' && <Devices api={api} registry={registry} />}
    {section === 'workspaces' && <Workspaces api={api} registry={registry} reload={reloadRegistry} />}
    {section === 'health' && <CenterHealth api={api} />}
    {section === 'guestbooks' && <GuestbookModeration api={api} workspaceId={workspaceId || ''} />}
    {section === 'labels' && <CenterLabels api={api} />}
    {section === 'account' && <Account />}
  </section>;
}
