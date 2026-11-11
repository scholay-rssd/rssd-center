'use client';
// The /rssd page: the whole Center in one interface. The work-centre view
// (./view) draws the tabs; this file supplies the Center's data and actions
// and the screens the view leaves to it (works, settings, drawers).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './view/fonts.css';
import './view/tokens.css';
import './live-center.css';
import CenterPreview from './view/center/preview/CenterPreview';
import { emptyLiveCenter, mapLiveCenter } from './view/center/preview/mapLive';
import { dayKey, type PreviewDemand, type PreviewDestination, type PreviewPublication, type PreviewTab } from './view/center/preview/model';
import { useRssdApi } from './api';
import { type Mode, useShellMode } from './mode';
import { WorksPanel, type DemandSource } from './works';
import { SettingsPanel, type SettingsSection } from './settings';
import { GoalsDrawer, NewDemandDrawer } from './planning';
import { AccountsDrawer, DestinationDrawer } from './channels-admin';

type Row = Record<string, any>;
type Overlay = { kind: 'demand'; source?: DemandSource } | { kind: 'goals'; workspaceId?: string } | { kind: 'destination'; destinationId?: string } | { kind: 'accounts'; focusId?: string } | null;
const PAGE = 200;
const views: PreviewTab[] = ['overview', 'demands', 'works', 'calendar', 'channels', 'settings'];
/** Where each earlier `?tab=` link leads now that its screen is part of the one interface. */
const movedTabs: Record<string, { view: PreviewTab; section?: SettingsSection; overlay?: 'goals' }> = {
  overview: { view: 'overview' }, goals: { view: 'overview', overlay: 'goals' }, demands: { view: 'demands' }, works: { view: 'works' },
  calendar: { view: 'calendar' }, publications: { view: 'calendar' }, destinations: { view: 'channels' },
  workers: { view: 'settings', section: 'devices' }, settings: { view: 'settings', section: 'workspaces' }, health: { view: 'settings', section: 'health' }, guestbooks: { view: 'settings', section: 'guestbooks' }, labels: { view: 'settings', section: 'labels' },
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RssdCenter({ initialTab, initialView, initialWorkspace, initialMode = 'dark', accountsAdded }: { initialTab?: string; initialView?: string; initialWorkspace?: string; initialMode?: Mode; /** Set when the browser has just returned from a platform's sign-in page. */ accountsAdded?: boolean } = {}) {
  const api = useRssdApi(), [mode, toggleMode] = useShellMode(initialMode);
  const moved = movedTabs[initialTab || ''];
  const view: PreviewTab = moved?.view || (views.includes(initialView as PreviewTab) ? initialView as PreviewTab : 'overview');
  // Each kind of Center data loads on its own, so moving the calendar or searching does not re-read the rest.
  const [base, setBase] = useState<{ overview: Row; channels: Row } | null>(null), [demands, setDemands] = useState<Row[]>([]), [calendar, setCalendar] = useState<Row>({ items: [] }), [registry, setRegistry] = useState<Row[]>([]);
  const [limit, setLimit] = useState(PAGE), [search, setSearch] = useState(''), [applied, setApplied] = useState(''), [more, setMore] = useState(false);
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 31 * 86400000).toISOString(), to: new Date(Date.now() + 62 * 86400000).toISOString() }));
  const [busy, setBusy] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [overlay, setOverlay] = useState<Overlay>(accountsAdded ? { kind: 'accounts' } : moved?.overlay === 'goals' ? { kind: 'goals', workspaceId: initialWorkspace } : null);
  const seq = useRef({ base: 0, demands: 0, calendar: 0 }), ready = useRef(false), opened = useRef({ works: view === 'works', settings: view === 'settings' });
  // A retry of the same change reuses its request id, so the Center applies it once.
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const requestId = (fingerprint: string) => { if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() }; return pending.current.requestId; };
  const track = useCallback(async (work: () => Promise<unknown>) => { setBusy(n => n + 1); setError(''); try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(n => n - 1); } }, []);
  const loadRegistry = useCallback(async () => { setRegistry((await api('/registry')).workspaces); }, [api]);
  const loadBase = useCallback(async () => {
    const id = ++seq.current.base;
    try {
      const [overview, channels] = await Promise.all([api('/coordination/overview'), api('/coordination/channels')]);
      if (id !== seq.current.base) return false;
      setBase({ overview, channels }); ready.current = true; return true;
    } catch (e) { if (id === seq.current.base) { setBase(null); setDemands([]); setCalendar({ items: [] }); } throw e; }
  }, [api]);
  const loadDemands = useCallback(async () => {
    const id = ++seq.current.demands, all: Row[] = []; let full = true;
    try {
      for (let offset = 0; offset < limit && full; offset += PAGE) {
        const page = await api('/demands?' + new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { search } : {}) }));
        all.push(...page); full = page.length === PAGE;
      }
      if (id === seq.current.demands) { setDemands(all); setMore(full); setApplied(search); }
    } catch (e) { if (id === seq.current.demands) { setDemands([]); setMore(false); } throw e; }
  }, [api, limit, search]);
  const loadCalendar = useCallback(async () => {
    const id = ++seq.current.calendar;
    try { const result = await api('/coordination/calendar?' + new URLSearchParams({ limit: '200', ...range })); if (id === seq.current.calendar) setCalendar(result); }
    catch (e) { if (id === seq.current.calendar) setCalendar({ items: [] }); throw e; }
  }, [api, range]);
  const latest = useRef({ loadDemands, loadCalendar }); latest.current = { loadDemands, loadCalendar };
  const refresh = useCallback(() => track(async () => { if (await loadBase()) await Promise.all([latest.current.loadDemands(), latest.current.loadCalendar(), loadRegistry()]); }), [track, loadBase, loadRegistry]);
  useEffect(() => { void refresh(); const current = seq.current; return () => { current.base++; current.demands++; current.calendar++; }; }, [refresh]);
  useEffect(() => { if (ready.current) void track(loadDemands); }, [loadDemands, track]);
  useEffect(() => { if (ready.current) void track(loadCalendar); }, [loadCalendar, track]);
  const mapped = useMemo(() => {
    if (!base) return { data: emptyLiveCenter(), error: '' };
    try { return { data: mapLiveCenter(base.overview, demands, calendar, base.channels), error: '' }; }
    catch (e) { return { data: emptyLiveCenter(), error: message(e) }; }
  }, [base, demands, calendar]);
  const updateDemand = async (task: PreviewDemand) => {
    const old = demands.find(d => d.id === task.id); if (!old) throw Error('请重新加载需求');
    const changes = { title: task.title, brief: task.requirements, priority: task.priority === (old.priority > 0 ? '优先' : '常规') ? old.priority : task.priority === '优先' ? 10 : 0, requiredLocales: task.languages, dueAt: task.due && old.payload.dueAt && task.due === dayKey(new Date(old.payload.dueAt)) ? old.payload.dueAt : task.due ? new Date(task.due + 'T23:59:59').toISOString() : null };
    await api('/demands/' + encodeURIComponent(task.id) + '/definition', 'PATCH', { requestId: requestId(JSON.stringify([task.id, old.generation, changes])), baseGeneration: old.generation, changes }); pending.current = null; await track(loadDemands);
  };
  const releaseDemand = async (task: PreviewDemand) => { await api('/demands/' + encodeURIComponent(task.id), 'PATCH', { action: 'release' }); await refresh(); };
  const schedule = async (item: PreviewPublication, scheduledAt: string) => {
    const record = item.record; if (!record) throw Error('请重新加载发布日历');
    const body = { expectedUpdatedAt: record.updatedAt, scheduledAt };
    await api('/publications/' + encodeURIComponent(record.publicationId) + '/schedule', 'POST', { ...body, requestId: requestId(JSON.stringify([record.publicationId, body])) }); pending.current = null; await track(loadCalendar);
  };
  const retry = async (item: PreviewPublication) => {
    if (!item.record) throw Error('请重新加载发布日历');
    await api('/publications/' + encodeURIComponent(item.record.publicationId) + '/retry', 'POST', {}); await track(loadCalendar);
  };
  // The view asks for a place by its old name; goals are a drawer here, the rest are tabs it already has.
  const manage = (tab: string, workspaceId?: string) => { if (tab === 'goals') setOverlay({ kind: 'goals', workspaceId: workspaceId && workspaceId !== '__postiz__' ? workspaceId : undefined }); };
  const manageChannel = (destination: PreviewDestination) => setOverlay(destination.record?.destinationId ? { kind: 'destination', destinationId: destination.record.destinationId } : { kind: 'accounts', focusId: destination.record?.integrationId });
  const close = () => setOverlay(null);
  const overlays = <>
    {notice && <p className="cp-notice ca-toast" role="status">{notice}<button onClick={() => setNotice('')}>知道了</button></p>}
    {overlay?.kind === 'demand' && base && <NewDemandDrawer api={api} workspaces={base.overview.workspaces} source={overlay.source} onClose={close} onCreated={text => { close(); setNotice(text); void refresh(); }} />}
    {overlay?.kind === 'goals' && base && <GoalsDrawer api={api} overview={base.overview} workspaceId={overlay.workspaceId} onClose={close} onSaved={refresh} />}
    {overlay?.kind === 'destination' && <DestinationDrawer api={api} workspaces={registry} destinationId={overlay.destinationId} onClose={close} onSaved={refresh} />}
    {overlay?.kind === 'accounts' && <AccountsDrawer focusId={overlay.focusId} onClose={close} onChanged={refresh} />}
  </>;
  return <div className="rssd-desktop" data-mode={mode}>
    <CenterPreview initialTab={view} live={{
      data: mapped.data, loading: busy > 0, error: error || mapped.error, refresh: () => void refresh(), updateDemand, manage, schedule, retry, overlays,
      tools: <button onClick={toggleMode}>{mode === 'dark' ? '浅色' : '深色'}</button>,
      newDemand: base ? () => setOverlay({ kind: 'demand' }) : undefined, releaseDemand,
      channelTools: <><button onClick={() => setOverlay({ kind: 'accounts' })}>社交账号</button><button className="cp-primary" onClick={() => setOverlay({ kind: 'destination' })}>添加发布渠道</button></>,
      manageChannel,
      // Each is mounted on first visit, then kept so an open manuscript or form survives a look at another tab.
      works: shown => { if (shown) opened.current.works = true; return opened.current.works ? <WorksPanel api={api} registry={registry} onDeriveDemand={source => setOverlay({ kind: 'demand', source })} /> : null; },
      settings: shown => { if (shown) opened.current.settings = true; return opened.current.settings ? <SettingsPanel api={api} registry={registry} reloadRegistry={loadRegistry} initialSection={moved?.section} workspaceId={initialWorkspace} /> : null; },
      search: setSearch, appliedSearch: applied, loadMore: more ? () => setLimit(n => n + PAGE) : undefined, calendarTruncated: Boolean(calendar.hasNext),
      calendarRange: (from, to) => setRange(old => { const next = { from: new Date(from + 'T00:00:00').toISOString(), to: new Date(to + 'T00:00:00').toISOString() }; return old.from === next.from && old.to === next.to ? old : next; }),
    }} />
  </div>;
}
