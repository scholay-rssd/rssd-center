'use client';
// Drawers that add a task to the pool and maintain production goals.
import { useRef, useState } from 'react';
import { Drawer } from './view/center/preview/parts';
import type { RssdApi } from './api';
import type { DemandSource } from './works';
import './center-admin.css';

type Row = Record<string, any>;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `source` makes it a translation or update of an existing work, with its workspace and section fixed. */
export function NewDemandDrawer({ api, workspaces, source, onClose, onCreated }: { api: RssdApi; workspaces: Row[]; source?: DemandSource; onClose: () => void; onCreated: (notice: string) => void }) {
  const writable = workspaces.filter(w => w.writable !== false);
  const [space, setSpace] = useState(source?.workspaceId || writable[0]?.id || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = workspaces.find(w => w.id === space);
  const defaultLanguages = source?.kind === 'translate' ? (source.source.locale === 'en' ? 'zh-CN' : 'en') : source?.kind === 'update' ? source.source.locale : 'both';
  return <Drawer title={source ? (source.kind === 'translate' ? '创建翻译需求' : '创建补充更新需求') : '新建需求'} onClose={onClose}>
    <form className="cp-detail-body cp-detail-form ca-form" onSubmit={event => {
      event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError('');
      const languages = String(values.get('languages'));
      api('/demands', 'POST', { workspaceId: space, sectionId: source?.sectionId || values.get('section'), kind: source?.kind || 'write', title: values.get('title'), brief: values.get('brief'), requiredLocales: languages === 'both' ? ['zh-CN', 'en'] : [languages], ...(source ? { source: source.source } : {}) })
        .then(result => onCreated(result.status === 'skipped' ? '该作品已有目标语言，未重复创建需求' : result.status === 'existing' ? '已有相同补译需求，沿用原任务' : '需求已加入需求池'))
        .catch(e => setError(message(e))).finally(() => setBusy(false));
    }}>
      <h2>把需要完成的内容放进需求池</h2>
      {source && <p className="cp-muted">{source.kind === 'translate' ? '翻译' : '补充更新'}：{source.title} · {source.source.locale} v{source.source.revision}</p>}
      {!writable.length && <p className="cp-muted">没有可写入的工作空间。</p>}
      <label>工作空间<select value={space} disabled={Boolean(source)} onChange={e => setSpace(e.target.value)}>{writable.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <label>栏目<select name="section" required key={space} defaultValue={source?.sectionId} disabled={Boolean(source)}>{active?.sections.map((s: Row) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>选题<input name="title" required maxLength={500} defaultValue={source?.title || ''} /></label>
      <label>写作要求<textarea name="brief" rows={6} /></label>
      <label>需要的语言<select name="languages" defaultValue={defaultLanguages}><option value="both">中文与英文</option><option value="zh-CN">仅中文</option><option value="en">仅英文</option></select></label>
      {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
      <footer><button className="cp-primary" disabled={busy || !space}>加入需求池</button></footer>
    </form>
  </Drawer>;
}

/** Goals of one workspace, or of every workspace when none is given. */
export function GoalsDrawer({ api, overview, workspaceId, onClose, onSaved }: { api: RssdApi; overview: Row; workspaceId?: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [goal, setGoal] = useState<Row | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  // A retry of the same goal reuses its request id, so the Center applies it once.
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const goals = overview.goals.filter((g: Row) => !workspaceId || g.workspaceId === workspaceId), name = (id: string) => overview.workspaces.find((w: Row) => w.id === id)?.name || id;
  const section = (g: Row) => overview.workspaces.find((w: Row) => w.id === g.workspaceId)?.sections.find((s: Row) => s.id === g.sectionId)?.name || g.sectionId;
  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!goal) return; setBusy(true); setError('');
    const values = new FormData(event.currentTarget), space = goal.workspaceId || String(values.get('workspaceId')), sectionId = goal.sectionId || String(values.get('sectionId'));
    const body = { id: goal.id || 'goal:' + space + ':' + sectionId, baseRevision: goal.revision || 0, goal: { workspaceId: space, sectionId, title: String(values.get('title')), brief: String(values.get('brief')), period: String(values.get('period')), timezone: String(values.get('timezone')), target: Number(values.get('target')), requiredLocales: values.getAll('languages'), enabled: values.get('enabled') === 'on' } };
    const fingerprint = JSON.stringify(body); if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    api('/goals', 'POST', { ...body, requestId: pending.current.requestId }).then(async () => { pending.current = null; setGoal(null); setNotice('目标已保存。启用后中心只补充需求，执行设备仍需认领。'); await onSaved(); }).catch(e => setError(message(e))).finally(() => setBusy(false));
  };
  return <Drawer title="生产目标" onClose={onClose}>
    <div className="cp-detail-body">
      <div className="cp-eyebrow">{workspaceId ? name(workspaceId) : '全部工作空间'}</div>
      <h2>目标与常驻维护</h2>
      <p className="cp-muted">按时区与周期维护需求池；同一作品的不同语言和渠道不会重复计算交稿数。目标默认为暂停，启用后才补充需求。</p>
      {error && <p role="alert" className="cp-notice ca-error">{error}</p>}
      {notice && <p role="status" className="cp-notice">{notice}</p>}
      {!goal && <>
        {!goals.length && <p className="cp-muted">尚未设置目标。</p>}
        {goals.map((g: Row) => <article className="ca-item" key={g.id}>
          <div><strong>{g.payload.title}</strong><small>{name(g.workspaceId)} / {section(g)} · {g.period.start} — {g.period.end} · {g.payload.timezone}</small>
            <small>目标 {g.payload.target} · 已交稿 {g.completed} · 在途 {g.pending} · 发布回执 {g.published}</small><small>{g.payload.enabled ? '已启用' : '已暂停'} · {g.status?.reason || '尚无维护记录'}</small></div>
          <button disabled={busy} onClick={() => { setGoal(g); setNotice(''); }}>调整</button>
        </article>)}
        <div className="ca-actions"><button className="cp-primary" disabled={busy || !overview.workspaces.length} onClick={() => { setGoal({}); setNotice(''); }}>新增生产目标</button></div>
      </>}
      {goal && <form className="cp-detail-form ca-form" onSubmit={save}>
        <h3>{goal.id ? '修改目标' : '新增目标'}</h3>
        <label>工作空间<select name="workspaceId" defaultValue={goal.workspaceId || workspaceId || overview.workspaces[0]?.id} disabled={Boolean(goal.id)}>{overview.workspaces.map((w: Row) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label>栏目标识<input name="sectionId" required defaultValue={goal.sectionId || ''} disabled={Boolean(goal.id)} list="rssd-goal-sections" /></label>
        <datalist id="rssd-goal-sections">{overview.workspaces.flatMap((w: Row) => w.sections.map((s: Row) => <option key={w.id + ':' + s.id} value={s.id}>{w.name} / {s.name}</option>))}</datalist>
        <label>选题方向<input name="title" required maxLength={400} defaultValue={goal.payload?.title || ''} /></label>
        <label>写作要求<textarea name="brief" rows={4} defaultValue={goal.payload?.brief || ''} /></label>
        <label>周期<select name="period" defaultValue={goal.payload?.period || 'week'}><option value="day">每日</option><option value="week">每周</option><option value="month">每月</option></select></label>
        <label>时区<input name="timezone" required defaultValue={goal.payload?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>
        <label>交稿目标<input name="target" type="number" min={0} max={1000} required defaultValue={goal.payload?.target || 0} /></label>
        <fieldset><legend>需要的语言</legend>{['zh-CN', 'en'].map(locale => <label className="ca-check" key={locale}><input type="checkbox" name="languages" value={locale} defaultChecked={goal.payload?.requiredLocales?.includes(locale) ?? true} />{locale === 'en' ? '英文' : '中文'}</label>)}</fieldset>
        <label className="ca-check"><input type="checkbox" name="enabled" defaultChecked={goal.payload?.enabled === true} />启用常驻需求维护</label>
        <footer><button type="button" disabled={busy} onClick={() => setGoal(null)}>取消</button><button className="cp-primary" disabled={busy}>保存目标</button></footer>
      </form>}
    </div>
  </Drawer>;
}
