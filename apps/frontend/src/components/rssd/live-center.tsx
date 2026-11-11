'use client';
// The /rssd page: the desktop work-centre view (./desktop-ui, copied from
// scholay-rssd/rssd) over this Center's own data. The management screens stay
// in ./workspace and appear as its last tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import './desktop-ui/fonts.css';
import './desktop-ui/tokens.css';
import './live-center.css';
import CenterPreview from './desktop-ui/center/preview/CenterPreview';
import { emptyLiveCenter, mapLiveCenter } from './desktop-ui/center/preview/mapLive';
import { dayKey, type PreviewDemand, type PreviewTab } from './desktop-ui/center/preview/model';
import { useRssdApi } from './api';
import { RssdWorkspace } from './workspace';

type Row = Record<string, any>;
type Mode = 'light' | 'dark';
const PAGE = 200;
const views: PreviewTab[] = ['overview', 'demands', 'calendar', 'channels', 'assistant'];
/** `?tab=` values that open a management screen, as every existing link expects. */
export const managementTabs = ['goals', 'calendar', 'demands', 'works', 'publications', 'workers', 'destinations', 'settings', 'health', 'guestbooks', 'labels'];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Follows the shell's light/dark switch, which sets a class on <body>. */
function useShellMode(initial: Mode): Mode {
  const [mode, setMode] = useState<Mode>(initial);
  useEffect(() => {
    const read = () => setMode(document.body.classList.contains('light') ? 'light' : document.body.classList.contains('dark') ? 'dark' : initial);
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [initial]);
  return mode;
}

export function RssdCenter({ initialTab, initialView, initialWorkspace, initialMode = 'dark' }: { initialTab?: string; initialView?: string; initialWorkspace?: string; initialMode?: Mode } = {}) {
  const api = useRssdApi(), router = useRouter(), mode = useShellMode(initialMode);
  const managed = managementTabs.includes(initialTab || '');
  // Each kind of Center data loads on its own, so moving the calendar or searching does not re-read the rest.
  const [base, setBase] = useState<{ overview: Row; channels: Row } | null>(null), [demands, setDemands] = useState<Row[]>([]), [calendar, setCalendar] = useState<Row>({ items: [] });
  const [limit, setLimit] = useState(PAGE), [search, setSearch] = useState(''), [applied, setApplied] = useState(''), [more, setMore] = useState(false);
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 31 * 86400000).toISOString(), to: new Date(Date.now() + 62 * 86400000).toISOString() }));
  const [busy, setBusy] = useState(0), [error, setError] = useState('');
  const seq = useRef({ base: 0, demands: 0, calendar: 0 }), ready = useRef(false), opened = useRef(managed);
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const track = useCallback(async (work: () => Promise<unknown>) => { setBusy(n => n + 1); setError(''); try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(n => n - 1); } }, []);
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
  const refresh = useCallback(() => track(async () => { if (await loadBase()) await Promise.all([latest.current.loadDemands(), latest.current.loadCalendar()]); }), [track, loadBase]);
  useEffect(() => { void refresh(); const current = seq.current; return () => { current.base++; current.demands++; current.calendar++; }; }, [refresh]);
  useEffect(() => { if (ready.current) void track(loadDemands); }, [loadDemands, track]);
  useEffect(() => { if (ready.current) void track(loadCalendar); }, [loadCalendar, track]);
  const mapped = useMemo(() => {
    if (!base) return { data: emptyLiveCenter(), error: '' };
    try { return { data: mapLiveCenter(base.overview, demands, calendar, base.channels), error: '' }; }
    catch (e) { return { data: emptyLiveCenter(), error: message(e) }; }
  }, [base, demands, calendar]);
  const manage = (tab: string, workspaceId?: string) => router.push('/rssd?' + new URLSearchParams({ tab, ...(workspaceId && workspaceId !== '__postiz__' ? { workspaceId } : {}) }));
  const updateDemand = async (task: PreviewDemand) => {
    const old = demands.find(d => d.id === task.id); if (!old) throw Error('请重新加载需求');
    const changes = { title: task.title, brief: task.requirements, priority: task.priority === (old.priority > 0 ? '优先' : '常规') ? old.priority : task.priority === '优先' ? 10 : 0, requiredLocales: task.languages, dueAt: task.due && old.payload.dueAt && task.due === dayKey(new Date(old.payload.dueAt)) ? old.payload.dueAt : task.due ? new Date(task.due + 'T23:59:59').toISOString() : null };
    // A retry of the same edit reuses its request id, so the Center applies it once.
    const fingerprint = JSON.stringify([task.id, old.generation, changes]); if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    await api('/demands/' + encodeURIComponent(task.id) + '/definition', 'PATCH', { requestId: pending.current.requestId, baseGeneration: old.generation, changes }); pending.current = null; await track(loadDemands);
  };
  const assistant = () => <div className="cp-assistant-welcome rssd-center-assistant">
    <h3>助手在执行设备上运行</h3>
    <p>选题与写作助手使用设备上的智能体账号，在无头执行端或桌面端启动。这里可以维护它们依据的生产目标，或使用中心自带的发布助手。</p>
    <div className="cp-suggestions"><button onClick={() => manage('goals')}>维护生产目标</button><button onClick={() => manage('workers')}>查看执行设备</button><button onClick={() => router.push('/agents')}>打开发布助手</button></div>
  </div>;
  const view = views.includes(initialView as PreviewTab) ? initialView as PreviewTab : 'overview';
  return <div className="rssd-desktop" data-mode={mode}>
    <CenterPreview initialTab={managed ? 'legacy' : view} live={{
      data: mapped.data, loading: busy > 0, error: error || mapped.error, refresh: () => void refresh(), updateDemand, manage, assistant,
      legacyLabel: '作品与管理',
      // Mounted on first visit, then kept so an open manuscript survives a look at another tab.
      legacy: shown => { if (shown) opened.current = true; return opened.current ? <RssdWorkspace embedded initialTab={managed ? initialTab : 'works'} initialWorkspace={initialWorkspace} /> : null; },
      search: setSearch, appliedSearch: applied, loadMore: more ? () => setLimit(n => n + PAGE) : undefined, calendarTruncated: Boolean(calendar.hasNext),
      calendarRange: (from, to) => setRange(old => { const next = { from: new Date(from + 'T00:00:00').toISOString(), to: new Date(to + 'T00:00:00').toISOString() }; return old.from === next.from && old.to === next.to ? old : next; }),
    }} />
  </div>;
}
