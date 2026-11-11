import { tr } from "../../uiText";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  createPreviewData,
  dayKey,
  monthDays,
  type PreviewTab,
  type PreviewDestination,
} from "./model";
import CalendarTab, { type CalendarView } from "./CalendarTab";
import ChannelsPreview from "./ChannelsPreview";
import DemandsTab from "./DemandsTab";
import { PublicationDetail, TaskDetail } from "./details";
import type { LiveCenterActions } from "./live";
import OverviewTab from "./OverviewTab";
import { Drawer, Icon } from "./parts";
import SampleAssistant, { type SampleTurn } from "./SampleAssistant";
import { BrandMark, NavigationIcon, WorkspaceIcon } from "./PreviewIcons";
import "./preview.css";

const tabs: Array<[PreviewTab, string]> = [
  ["overview", "全局总览"],
  ["demands", "需求池"],
  ["calendar", "发布日历"],
  ["channels", "发布渠道"],
  ["assistant", "中心助手"],
];
export type { LiveCenterActions } from "./live";
const legacyTab: [PreviewTab, string] = ["legacy", "作品与本机执行"];
export default function CenterPreview({
  live,
  initialTab = "overview",
  initialWorkspace,
}: {
  live?: LiveCenterActions;
  initialTab?: PreviewTab;
  initialWorkspace?: string;
}) {
  const [data, setData] = useState(() => live?.data || createPreviewData()),
    [tab, setTab] = useState<PreviewTab>(initialTab);
  const [scope, setScope] = useState<string[]>(() =>
    (live?.data || createPreviewData()).spaces.map((s) => s.id),
  );
  const [search, setSearch] = useState(""),
    [state, setState] = useState("all"),
    [notice, setNotice] = useState("");
  const [selectedTask, setSelectedTask] = useState<string | null>(null),
    [selectedPublication, setSelectedPublication] = useState<string | null>(
      null,
    ),
    [targetSpace, setTargetSpace] = useState<string | null>(null);
  const [date, setDate] = useState(data.weekStart),
    [calendarView, setCalendarView] = useState<CalendarView>("week"),
    [destination, setDestination] = useState("all");
  const [agent, setAgent] = useState("Codex"),
    [message, setMessage] = useState("");
  const [conversation, setConversation] = useState<SampleTurn[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDetailsElement>(null);
  const [selectedDestination, setSelectedDestination] =
    useState<PreviewDestination | null>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(event.target as Node))
        scopeRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && scopeRef.current)
        scopeRef.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    const messages = messagesRef.current;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, [conversation]);
  const liveLoaded=useRef(false);
  useEffect(()=>{if(!live)return;setData(live.data);setScope(old=>{const ids=live.data.spaces.map(s=>s.id);if(!liveLoaded.current&&ids.length){liveLoaded.current=true;return initialWorkspace&&ids.includes(initialWorkspace)?[initialWorkspace]:ids;}return old.filter(id=>ids.includes(id));});},[live?.data]);
  useEffect(()=>{if(live&&targetSpace){live.manage('goals',targetSpace);setTargetSpace(null);}},[targetSpace,live]);
  const hasAssistant = !live || Boolean(live.assistant);
  const shownTabs: Array<[PreviewTab, string]> = [
    tabs[0],
    tabs[1],
    ...(live?.works ? [["works", "作品库"] as [PreviewTab, string]] : []),
    tabs[2],
    tabs[3],
    ...(hasAssistant ? [tabs[4]] : []),
    ...(live?.settings ? [["settings", "设置"] as [PreviewTab, string]] : []),
    ...(live?.legacy ? [[legacyTab[0], live.legacyLabel || legacyTab[1]] as [PreviewTab, string]] : []),
  ];
  // The tabs that list work across workspaces; the library and settings choose their own.
  const scoped = tab !== "works" && tab !== "settings" && tab !== "legacy";
  const scopeName =
    scope.length === data.spaces.length
      ? tr("全部工作空间")
      : scope.length === 1
        ? data.spaces.find((s) => s.id === scope[0])?.name || tr("工作空间")
        : scope.length
          ? tr("{{count}} 个工作空间", { count: scope.length })
          : tr("未选择工作空间");
  const spaces = data.spaces.filter((s) => scope.includes(s.id));
  const spaceById = Object.fromEntries(data.spaces.map((s) => [s.id, s]));
  const demands = data.demands.filter((d) => scope.includes(d.workspaceId));
  const demandCount=(state:string)=>data.demandCounts?data.demandCounts.filter(r=>scope.includes(r.workspaceId)&&(state==='all'?r.state!=='cancelled':r.state===state)).reduce((n,r)=>n+r.count,0):demands.filter(d=>state==='all'||d.state===state).length;
  const publications = data.publications.filter((p) =>
    scope.includes(p.workspaceId),
  );
  const term = search.trim();
  useEffect(() => {
    if (!live?.search) return;
    const timer = setTimeout(() => live.search!(term), 300);
    return () => clearTimeout(timer);
  }, [term]);
  // Once the Center has answered for this text, its matches (title or brief) are the list.
  const answered = Boolean(live?.search) && term !== "" && live!.appliedSearch === term;
  const filteredDemands = demands.filter(
    (d) =>
      (state === "all" || d.state === state) &&
      (answered ||
        [d.title, d.section, spaceById[d.workspaceId].name]
          .join(" ")
          .toLocaleLowerCase()
          .includes(term.toLocaleLowerCase())),
  );
  const queuedIn = (workspaceId: string) =>
    data.demandCounts
      ? data.demandCounts
          .filter((r) => r.workspaceId === workspaceId && r.state === "queued")
          .reduce((n, r) => n + r.count, 0)
      : demands.filter((d) => d.workspaceId === workspaceId && d.state === "queued").length;
  const days = useMemo(
    () =>
      calendarView === "month"
        ? monthDays(date)
        : Array.from({ length: 7 }, (_, i) => addDays(date, i)),
    [calendarView, date],
  );
  useEffect(()=>{if(live)live.calendarRange(days[0],addDays(days[days.length-1],1));},[days]);
  const calendarItems = publications
    .filter(
      (p) =>
        days.includes(p.date) &&
        (destination === "all" ||
          p.destination === destination ||
          data.destinations.some(
            (d) => d.name === p.destination && d.kind === destination,
          )),
    )
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const task = data.demands.find((d) => d.id === selectedTask),
    publication = data.publications.find((p) => p.id === selectedPublication);
  const total = spaces.reduce((n, s) => n + s.target, 0),
    completed = spaces.reduce((n, s) => n + s.completed, 0);
  const changeTab = (value: PreviewTab) => {
    setTab(value);
    setNotice("");
    setSearch("");
    setState("all");
  };
  const taskView = (value: string) => {
    changeTab("demands");
    setState(value);
  };
  const moveCalendar = (direction: number) => {
    if (calendarView === "month") {
      const next = new Date(date + "T12:00:00");
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
      setDate(dayKey(next));
    } else setDate(addDays(date, direction * 7));
  };
  const reset = () => {
    if(live){live.refresh();return;}
    setData(createPreviewData());
    setScope(createPreviewData().spaces.map((s) => s.id));
    setConversation([]);
    setMessage("");
    setDate(data.weekStart);
    setDestination("all");
    setState("all");
    setSearch("");
    setNotice(tr("示例数据已重置。"));
  };
  return (
    <main className="center-preview cp-shell">
      <aside className="cp-side">
        <div className="cp-side-brand">
          <BrandMark />
          <span>
            {tr("RSSD 中心")}
            {!live && <small>{tr("示例数据 · 操作仅在本页生效")}</small>}
          </span>
        </div>
        <nav className="cp-side-nav" aria-label={tr("中心功能")}>
          {shownTabs.map(([id, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => changeTab(id)}
            >
              <NavigationIcon tab={id} />
              {tr(label)}
              {id === "demands" && <span>{demandCount("queued")}</span>}
            </button>
          ))}
        </nav>
        <div className="cp-side-foot">
          {/* Narrowing by workspace is offered only on the tabs it changes. */}
          <details ref={scopeRef} className="cp-scope" hidden={!scoped}>
            <summary>
              {scopeName}
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="cp-scope-menu">
              <header>
                <strong>{tr("查看范围")}</strong>
                <button onClick={() => setScope(data.spaces.map((s) => s.id))}>
                  {tr("全选")}
                </button>
                <button onClick={() => setScope([])}>{tr("清除")}</button>
              </header>
              {data.spaces.map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={scope.includes(s.id)}
                    onChange={(e) =>
                      setScope((old) =>
                        e.target.checked
                          ? [...old, s.id]
                          : old.filter((id) => id !== s.id),
                      )
                    }
                  />
                  <WorkspaceIcon workspaceId={s.id} size={22} />
                  {s.name}
                </label>
              ))}
            </div>
          </details>
          {live?.execution && (
            <button
              className="cp-execution"
              title={live.execution.notes.join(" ")}
              onClick={() => changeTab("legacy")}
            >
              {live.execution.running && <span className="cp-dot" />}
              {tr("本机执行")} · {live.execution.label}
              {live.execution.notes.length > 0 && <b>{live.execution.notes.length}</b>}
            </button>
          )}
          <div className="cp-side-tools">
            {live?.tools}
            <button disabled={live?.loading} onClick={reset}>
              {tr(live ? (live.loading ? "读取中…" : "刷新") : "重置预览")}
            </button>
          </div>
        </div>
      </aside>
      <div className="cp-main">
      {live?.error&&<p role="alert" className="cp-notice">{live.error}</p>}
      {live?.execution && live.execution.notes.length > 0 && tab !== "legacy" && (
        <p className="cp-notice cp-held" role="status">
          <span>{live.execution.notes.join(" ")}</span>
          <button onClick={() => changeTab("legacy")}>{tr("前往处理")}</button>
        </p>
      )}
      {notice && (
        <p className="cp-notice" role="status">
          {notice}
          <button aria-label={tr("关闭提示")} onClick={() => setNotice("")}>
            <Icon kind="close" />
          </button>
        </p>
      )}
      {live?.legacy && (
        // Stays mounted so an open manuscript survives a visit to another tab.
        <div hidden={tab !== "legacy"}>{live.legacy(tab === "legacy")}</div>
      )}
      {live?.works && (
        <div hidden={tab !== "works"}>{live.works(tab === "works")}</div>
      )}
      {live?.settings && (
        <div hidden={tab !== "settings"}>{live.settings(tab === "settings")}</div>
      )}
      <div className="cp-content" key={tab}>
        {tab === "overview" && (
          <OverviewTab
            live={live}
            hasAssistant={hasAssistant}
            spaces={spaces}
            demands={demands}
            spaceById={spaceById}
            completed={completed}
            total={total}
            demandCount={demandCount}
            queuedIn={queuedIn}
            changeTab={changeTab}
            taskView={taskView}
            setScope={setScope}
            setTargetSpace={setTargetSpace}
            setSelectedTask={setSelectedTask}
          />
        )}
        {tab === "demands" && (
          <DemandsTab
            live={live}
            hasAssistant={hasAssistant}
            onNew={live?.newDemand}
            filteredDemands={filteredDemands}
            spaceById={spaceById}
            state={state}
            setState={setState}
            search={search}
            setSearch={setSearch}
            term={term}
            demandCount={demandCount}
            changeTab={changeTab}
            setMessage={setMessage}
            setSelectedTask={setSelectedTask}
          />
        )}
        {tab === "calendar" && (
          <CalendarTab
            live={live}
            data={data}
            calendarItems={calendarItems}
            days={days}
            date={date}
            setDate={setDate}
            calendarView={calendarView}
            setCalendarView={setCalendarView}
            destination={destination}
            setDestination={setDestination}
            moveCalendar={moveCalendar}
            setSelectedPublication={setSelectedPublication}
          />
        )}
        {tab === "channels" && (
          <ChannelsPreview
            liveMode={Boolean(live)}
            tools={live?.channelTools}
            spaces={spaces}
            destinations={data.destinations}
            publications={publications}
            onManage={live?.manageChannel || setSelectedDestination}
            onCalendar={(name) => {
              changeTab("calendar");
              setDestination(name);
              setDate(data.weekStart);
            }}
          />
        )}
        {tab === "assistant" && live?.assistant?.(scope)}
        {tab === "assistant" && !live && (
          <SampleAssistant
            messagesRef={messagesRef}
            conversation={conversation}
            setConversation={setConversation}
            message={message}
            setMessage={setMessage}
            agent={agent}
            setAgent={setAgent}
            scope={scope}
            scopeName={scopeName}
          />
        )}
      </div>
      {task && (
        <TaskDetail
          key={task.id}
          task={task}
          liveMode={Boolean(live)}
          space={spaceById[task.workspaceId]}
          onClose={() => setSelectedTask(null)}
          onUpdate={(updated) => {
            if(live){void live.updateDemand(updated).then(()=>{setSelectedTask(null);setNotice(tr("需求已保存到中心。"));}).catch(e=>setNotice(String(e)));return;}
            setData((old) => ({
              ...old,
              demands: old.demands.map((d) =>
                d.id === updated.id ? updated : d,
              ),
            }));
            setSelectedTask(null);
            setNotice(tr("任务调整已应用到预览，未提交中心。"));
          }}
          onRelease={live?.releaseDemand && (task.state === "claimed" || task.state === "blocked") ? () => {
            void live.releaseDemand!(task).then(()=>{setSelectedTask(null);setNotice(tr("认领已释放，任务回到待领取。"));}).catch(e=>setNotice(e instanceof Error ? e.message : String(e)));
          } : undefined}
          onClaim={live && !live.claim ? undefined : () => {
            if(live){void live.claim!(task).then(()=>{setSelectedTask(null);setNotice(tr("已请求本机执行，请查看实际认领状态。"));}).catch(e=>setNotice(String(e)));return;}
            setData((old) => ({
              ...old,
              demands: old.demands.map((d) =>
                d.id === task.id
                  ? { ...d, state: "claimed", owner: tr("本机 · 模拟认领") }
                  : d,
              ),
            }));
            setSelectedTask(null);
            setNotice(tr("已模拟认领，仅用于查看界面状态，未启动生产。"));
          }}
        />
      )}
      {publication && (
        <PublicationDetail
          key={publication.id}
          item={publication}
          liveMode={Boolean(live)}
          space={spaceById[publication.workspaceId]}
          onClose={() => setSelectedPublication(null)}
          onSchedule={live?.schedule && ((scheduledAt) => live.schedule!(publication, scheduledAt).then(() => { setSelectedPublication(null); setNotice(tr("排期已保存到中心，原发布身份不变。")); }))}
          onRetry={live?.retry && (() => live.retry!(publication).then(() => { setSelectedPublication(null); setNotice(tr("已请求中心恢复原发布，请稍后查看结果。")); }))}
          onUpdate={(updated) => {
            if(live)return;
            setData((old) => ({
              ...old,
              publications: old.publications.map((p) =>
                p.id === updated.id ? updated : p,
              ),
            }));
            setSelectedPublication(null);
            setNotice(tr("排期已应用到预览，未提交中心。"));
          }}
        />
      )}
      {live?.overlays}
      {selectedDestination && (
        <Drawer
          title={tr(live?"渠道详情":"渠道详情 · 示例")}
          onClose={() => setSelectedDestination(null)}
        >
          <div className="cp-detail-body">
            <div className="cp-eyebrow">{tr(selectedDestination.platform)}</div>
            <h2>{selectedDestination.name}</h2>
            <dl className="cp-facts">
              <dt>{tr("账号或站点")}</dt>
              <dd>{selectedDestination.account}</dd>
              <dt>{tr("连接方式")}</dt>
              <dd>{selectedDestination.auth}</dd>
              <dt>{tr("内容来源")}</dt>
              <dd>
                {selectedDestination.workspaceIds
                  .map((id) => spaceById[id].name)
                  .join("、")}
              </dd>
            </dl>
            <p>
              {tr(
                "正式使用时，在浏览器中的 RSSD 中心完成账号授权、重新连接和渠道配置。桌面展示同一份渠道状态与发布结果。",
              )}
            </p>
            <p className="cp-muted">
              {tr(live?"连接状态来自中心。账号授权和配置在浏览器中管理。":"当前账号和状态均为示例。此预览没有读取或改变真实授权。")}
            </p>
            <footer>
              <button
                onClick={() => {
                  setSelectedDestination(null);
                  changeTab("calendar");
                  setDestination(selectedDestination.name);
                  setDate(data.weekStart);
                }}
              >
                {tr("查看发布安排")}
              </button>
            </footer>
          </div>
        </Drawer>
      )}
      {targetSpace && (
        <Drawer
          title={tr("生产目标 · 示例")}
          onClose={() => setTargetSpace(null)}
        >
          <form
            className="cp-detail-body cp-detail-form"
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget),
                target = Number(values.get("target"));
              if (!Number.isInteger(target) || target < 0 || target > 1000)
                return;
              setData((old) => ({
                ...old,
                spaces: old.spaces.map((s) =>
                  s.id === targetSpace ? { ...s, target } : s,
                ),
              }));
              setTargetSpace(null);
              setNotice(tr("目标已应用到预览，未创建或修改真实需求。"));
            }}
          >
            <div className="cp-eyebrow">{spaceById[targetSpace].name}</div>
            <h2>{tr("调整生产目标")}</h2>
            <p className="cp-muted">
              {tr("目标按作品交稿数量计算，中英文分发不重复计为多篇。")}
            </p>
            <label>
              {tr("演示周期")}
              <input readOnly value={tr("2026 年 11 月 2 日—8 日")} />
            </label>
            <label>
              {tr("计划交稿数量")}
              <input
                name="target"
                type="number"
                required
                min={0}
                max={1000}
                defaultValue={spaceById[targetSpace].target}
              />
            </label>
            <footer>
              <button className="cp-primary">{tr("应用到预览")}</button>
            </footer>
          </form>
        </Drawer>
      )}
      </div>
    </main>
  );
}
