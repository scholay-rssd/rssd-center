import { tr } from "../../uiText";
import type { LiveCenterActions } from "./live";
import { demandLabels, type PreviewDemand, type PreviewSpace, type PreviewTab } from "./model";
import { Empty, Icon } from "./parts";
import { WorkspaceIcon } from "./PreviewIcons";

export default function OverviewTab({
  live,
  spaces,
  demands,
  spaceById,
  completed,
  total,
  demandCount,
  queuedIn,
  changeTab,
  taskView,
  setScope,
  setTargetSpace,
  setSelectedTask,
}: {
  live?: LiveCenterActions;
  spaces: PreviewSpace[];
  demands: PreviewDemand[];
  spaceById: Record<string, PreviewSpace>;
  completed: number;
  total: number;
  demandCount: (state: string) => number;
  queuedIn: (workspaceId: string) => number;
  changeTab: (tab: PreviewTab) => void;
  taskView: (state: string) => void;
  setScope: (workspaceIds: string[]) => void;
  setTargetSpace: (workspaceId: string) => void;
  setSelectedTask: (id: string) => void;
}) {
  return (
    <>
      <div className="cp-section-heading">
        <div>
          <h2>{tr("生产概览")}</h2>
          <p>{live ? tr("各目标当前周期汇总；周期与时区以中心配置为准。") : tr("演示周期 · 2026 年 11 月 2 日—8 日")}</p>
        </div>
        <button onClick={() => changeTab("calendar")}>
          {tr("查看发布日历")}
          <Icon kind="arrow" />
        </button>
      </div>
      <div className="cp-metrics">
        <div>
          <span>{tr("本周期交稿 / 目标")}</span>
          <strong>
            {completed}
            <small> / {total}</small>
          </strong>
          <p>{tr("按作品计数，分发次数单独记录")}</p>
        </div>
        <button onClick={() => taskView("queued")}>
          <span>{tr(demandLabels.queued)}</span>
          <strong>
            {demandCount("queued")}
          </strong>
          <p>{tr("已准备任务说明")}</p>
        </button>
        <button onClick={() => taskView("claimed")}>
          <span>{tr(demandLabels.claimed)}</span>
          <strong>
            {demandCount("claimed")}
          </strong>
          <p>{tr("由已认领设备继续执行")}</p>
        </button>
        <button onClick={() => taskView("blocked")}>
          <span>{tr(demandLabels.blocked)}</span>
          <strong>
            {demandCount("blocked")}
          </strong>
          <p>{tr("保留任务与已有结果")}</p>
        </button>
      </div>
      <div className="cp-overview-columns">
        <section>
          <div className="cp-section-heading">
            <h2>{tr("各工作空间")}</h2>
            <span className="cp-muted">
              {spaces.length}
              {tr("个空间 · 交稿进度")}
            </span>
          </div>
          <div className="cp-table-wrap">
            <table className="cp-space-table">
              <thead>
                <tr>
                  <th>{tr("工作空间")}</th>
                  <th>{tr("本周期目标")}</th>
                  <th>{tr("完成进度")}</th>
                  <th>{tr("待领取")}</th>
                  <th>
                    <span className="cp-sr-only">{tr("操作")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {spaces.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <button
                        className="cp-space-name"
                        onClick={() => {
                          setScope([s.id]);
                          taskView("all");
                        }}
                      >
                        <WorkspaceIcon workspaceId={s.id} />
                        <span>
                          {s.name}
                          <small>{s.sections.join(" · ")}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      {s.target}
                      {tr("篇")}
                    </td>
                    <td>
                      <div className="cp-progress">
                        <progress
                          value={s.completed}
                          max={Math.max(1, s.target)}
                        />
                        <span>
                          {s.completed} / {s.target}
                        </span>
                      </div>
                    </td>
                    <td>
                      {queuedIn(s.id)}
                    </td>
                    <td>
                      <button
                        className="cp-text-button"
                        onClick={() => setTargetSpace(s.id)}
                      >
                        {tr("调整目标")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!spaces.length && (
              <Empty
                title={tr("请选择工作空间")}
                text={tr("从右上角选择一个或多个工作空间。")}
              />
            )}
          </div>
        </section>
        <aside className="cp-overview-aside">
          <div className="cp-section-heading">
            <h2>{tr("优先关注")}</h2>
            <span className="cp-dot" />
          </div>
          {demands
            .filter(
              (d) =>
                d.state === "blocked" ||
                (d.priority === "优先" && d.state === "queued"),
            )
            .slice(0, 3)
            .map((d) => (
              <button
                className="cp-attention"
                key={d.id}
                onClick={() => setSelectedTask(d.id)}
              >
                <span className={"cp-state cp-" + d.state}>
                  {tr(demandLabels[d.state])}
                </span>
                <strong>{d.title}</strong>
                <small>
                  {spaceById[d.workspaceId].name} · {d.section}
                </small>
                <span>
                  {d.state === "blocked"
                    ? tr("查看原因与保留结果")
                    : tr("查看写作角度与任务说明")}{" "}
                  <span aria-hidden="true">↗</span>
                </span>
              </button>
            ))}
          {!demands.some(
            (d) =>
              d.state === "blocked" ||
              (d.priority === "优先" && d.state === "queued"),
          ) && (
            <p className="cp-muted">
              {tr("当前范围没有需要优先关注的任务。")}
            </p>
          )}
          <div className="cp-aside-note">
            <span>{tr("线上管理助手")}</span>
            <strong>{tr("按目标维护需求池")}</strong>
            <p>
              {live
                ? tr("在中心管理生产目标，选择本机智能体执行任务。退出桌面后，已启用的目标仍会继续维护。")
                : tr("这里预留最近巡检、调整理由与运行状态。实际服务由中心接入。")}
            </p>
            <button onClick={() => changeTab("assistant")}>
              {tr("查看助手界面")}
              <Icon kind="arrow" />
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}
