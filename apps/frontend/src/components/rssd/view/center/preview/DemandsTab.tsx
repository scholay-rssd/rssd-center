import { tr } from "../../uiText";
import type { LiveCenterActions } from "./live";
import { demandLabels, type PreviewDemand, type PreviewSpace, type PreviewTab } from "./model";
import { Empty, Icon, shortDate } from "./parts";

export default function DemandsTab({
  live,
  filteredDemands,
  spaceById,
  state,
  setState,
  search,
  setSearch,
  term,
  demandCount,
  changeTab,
  setMessage,
  setSelectedTask,
  hasAssistant,
}: {
  live?: LiveCenterActions;
  /** The rows to list: already narrowed by workspace, state and search. */
  filteredDemands: PreviewDemand[];
  spaceById: Record<string, PreviewSpace>;
  state: string;
  setState: (state: string) => void;
  search: string;
  setSearch: (text: string) => void;
  term: string;
  demandCount: (state: string) => number;
  hasAssistant: boolean;
  changeTab: (tab: PreviewTab) => void;
  setMessage: (text: string) => void;
  setSelectedTask: (id: string) => void;
}) {
  return (
    <>
      <div className="cp-section-heading">
        <div>
          <h2>{tr("需求池")}</h2>
          <p>{tr("每条需求包含初始写法，认领后按原要求执行。")}</p>
        </div>
        {hasAssistant && (
          <button
            className="cp-primary"
            onClick={() => {
              changeTab("assistant");
              setMessage(tr("根据当前目标，检查需求缺口并准备新的选题。"));
            }}
          >
            {tr("让助手补充选题")}
            <Icon kind="plus" />
          </button>
        )}
      </div>
      <div className="cp-filter-row">
        <div
          className="cp-state-filters"
          aria-label={tr("按任务状态筛选")}
        >
          {[["all", "全部"], ...Object.entries(demandLabels)].map(
            ([id, label]) => (
              <button
                key={id}
                aria-pressed={state === id}
                onClick={() => setState(id)}
              >
                {tr(label)}
                <span>
                  {id === "all"
                    ? demandCount("all")
                    : demandCount(id)}
                </span>
              </button>
            ),
          )}
        </div>
        <label className="cp-search">
          <Icon kind="search" />
          <input
            aria-label={tr("搜索需求")}
            type="search"
            placeholder={tr("搜索选题、栏目…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="cp-table-wrap">
        <table className="cp-demands-table">
          <thead>
            <tr>
              <th>{tr("选题与栏目")}</th>
              <th>{tr("任务")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("计划交稿")}</th>
              <th>{tr("执行设备")}</th>
              <th>{tr("优先级")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredDemands.map((d) => (
              <tr key={d.id}>
                <td>
                  <button
                    className="cp-task-title"
                    onClick={() => setSelectedTask(d.id)}
                  >
                    {d.title}
                  </button>
                  <small>
                    {spaceById[d.workspaceId].name} / {d.section} ·{" "}
                    {d.languages.join(" / ")}
                  </small>
                </td>
                <td>{tr(d.kind)}</td>
                <td>
                  <span className={"cp-state cp-" + d.state}>
                    {tr(demandLabels[d.state])}
                  </span>
                </td>
                <td>
                  <time dateTime={d.due}>{shortDate(d.due)}</time>
                </td>
                <td>
                  {d.owner || (
                    <span className="cp-muted">{tr("等待认领")}</span>
                  )}
                </td>
                <td>
                  <span
                    className={d.priority === "优先" ? "cp-priority" : ""}
                  >
                    {tr(d.priority)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filteredDemands.length && (
          <Empty
            title={tr("没有匹配的需求")}
            text={tr("试试其他工作空间、状态或搜索词。")}
          />
        )}
      </div>
      {live?.loadMore && (
        <p className="cp-list-footer">
          {term
            ? tr("已显示 {{shown}} 条匹配的需求，中心还有更多。", { shown: filteredDemands.length })
            : tr("已显示 {{shown}} / {{total}} 条", { shown: filteredDemands.length, total: demandCount(state) })}
          <button disabled={live.loading} onClick={live.loadMore}>
            {tr("加载更多")}
          </button>
        </p>
      )}
    </>
  );
}
