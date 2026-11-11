'use client';
// The /rssd page: the work-centre view (./view) over this Center's own data.
// It is the Center's home and has its own shell (./shell); the screens not yet
// moved into the view stay in ./workspace and appear as its last tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import './view/fonts.css';
import './view/tokens.css';
import './live-center.css';
import CenterPreview from './view/center/preview/CenterPreview';
import { emptyLiveCenter, mapLiveCenter } from './view/center/preview/mapLive';
import { dayKey, type PreviewDemand, type PreviewPublication, type PreviewTab } from './view/center/preview/model';
import { useRssdApi } from './api';
import { RssdWorkspace } from './workspace';

type Row = Record<string, any>;
type Mode = 'light' | 'dark';
const PAGE = 200;
const views: PreviewTab[] = ['overview', 'demands', 'calendar', 'channels'];
/** `?tab=` values that still open a management screen. */
export const managementTabs = ['goals', 'demands', 'works', 'workers', 'destinations', 'settings', 'health', 'guestbooks', 'labels'];
/** Earlier `?tab=` links whose screen is now part of the view. */
const movedTabs: Record<string, PreviewTab> = { overview: 'overview', calendar: 'calendar', publications: 'calendar' };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The shell's light/dark choice: the `mode` cookie and a class on <body>, shared with the publishing tools' pages. */
function useShellMode(initial: Mode): [Mode, () => void] {
  const [mode, setMode] = useState<Mode>(initial);
  useEffect(() => {
    const body = document.body;
    if (!body.classList.contains(initial)) { body.classList.remove('dark', 'light'); body.classList.add(initial); }
    const read = () => setMode(body.classList.contains('light') ? 'light' : 'dark');
    const observer = new MutationObserver(read);
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [initial]);
  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    document.cookie = 'mode=' + next + '; path=/; max-age=31536000; SameSite=Lax';
    document.body.classList.remove('dark', 'light'); document.body.classList.add(next);
  };
  return [mode, toggle];
}

export function RssdCenter({ initialTab, initialView, initialWorkspace, initialMode = 'dark' }: { initialTab?: string; initialView?: string; initialWorkspace?: string; initialMode?: Mode } = {}) {
  const api = useRssdApi(), router = useRouter(), [mode, toggleMode] = useShellMode(initialMode);
  const managed = managementTabs.includes(initialTab || '');
  // Each kind of Center data loads on its own, so moving the calendar or searching does not re-read the rest.
  const [base, setBase] = useState<{ overview: Row; channels: Row } | null>(null), [demands, setDemands] = useState<Row[]>([]), [calendar, setCalendar] = useState<Row>({ items: [] });
  const [limit, setLimit] = useState(PAGE), [search, setSearch] = useState(''), [applied, setApplied] = useState(''), [more, setMore] = useState(false);
  const [range, setRange] = useState(() => ({ from: new Date(Date.now() - 31 * 86400000).toISOString(), to: new Date(Date.now() + 62 * 86400000).toISOString() }));
  const [busy, setBusy] = useState(0), [error, setError] = useState('');
  const seq = useRef({ base: 0, demands: 0, calendar: 0 }), ready = useRef(false), opened = useRef(managed);
  // A retry of the same change reuses its request id, so the Center applies it once.
  const pending = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const requestId = (fingerprint: string) => { if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() }; return pending.current.requestId; };
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
    await api('/demands/' + encodeURIComponent(task.id) + '/definition', 'PATCH', { requestId: requestId(JSON.stringify([task.id, old.generation, changes])), baseGeneration: old.generation, changes }); pending.current = null; await track(loadDemands);
  };
  const schedule = async (item: PreviewPublication, scheduledAt: string) => {
    const record = item.record; if (!record) throw Error('请重新加载发布日历');
    const body = { expectedUpdatedAt: record.updatedAt, scheduledAt };
    await api('/publications/' + encodeURIComponent(record.publicationId) + '/schedule', 'POST', { ...body, requestId: requestId(JSON.stringify([record.publicationId, body])) }); pending.current = null; await track(loadCalendar);
  };
  const retry = async (item: PreviewPublication) => {
    if (!item.record) throw Error('请重新加载发布日历');
    await api('/publications/' + encodeURIComponent(item.record.publicationId) + '/retry', 'POST', {}); await track(loadCalendar);
  };
  const tools = <>
    <a href="/launches">发布工具</a><a href="/media">媒体库</a><a href="/analytics">统计</a><a href="/settings">账号与授权</a>
    <button onClick={toggleMode}>{mode === 'dark' ? '浅色' : '深色'}</button>
  </>;
  const view = movedTabs[initialTab || ''] || (views.includes(initialView as PreviewTab) ? initialView as PreviewTab : 'overview');
  return <div className="rssd-desktop" data-mode={mode}>
    <CenterPreview initialTab={managed ? 'legacy' : view} live={{
      data: mapped.data, loading: busy > 0, error: error || mapped.error, refresh: () => void refresh(), updateDemand, manage, tools, schedule, retry,
      legacyLabel: '作品与管理',
      // Mounted on first visit, then kept so an open manuscript survives a look at another tab.
      legacy: shown => { if (shown) opened.current = true; return opened.current ? <RssdWorkspace embedded initialTab={managed ? initialTab : 'works'} initialWorkspace={initialWorkspace} /> : null; },
      search: setSearch, appliedSearch: applied, loadMore: more ? () => setLimit(n => n + PAGE) : undefined, calendarTruncated: Boolean(calendar.hasNext),
      calendarRange: (from, to) => setRange(old => { const next = { from: new Date(from + 'T00:00:00').toISOString(), to: new Date(to + 'T00:00:00').toISOString() }; return old.from === next.from && old.to === next.to ? old : next; }),
    }} />
  </div>;
}
