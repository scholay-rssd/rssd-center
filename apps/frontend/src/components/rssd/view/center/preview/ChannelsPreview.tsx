import { tr } from "../../uiText";
import { useState, type ReactNode } from "react";
import { DestinationIcon } from "./PreviewIcons";
import AppIcon from "../../components/Icon";
import type {
  PreviewDestination,
  PreviewPublication,
  PreviewSpace,
} from "./model";

export default function ChannelsPreview({
  spaces,
  liveMode=false,
  destinations,
  publications,
  onManage,
  onCalendar,
  tools,
}: {
  liveMode?:boolean;
  /** Channel actions of a real Center; replaces the note that management happens elsewhere. */
  tools?: ReactNode;
  spaces: PreviewSpace[];
  destinations: PreviewDestination[];
  publications: PreviewPublication[];
  onManage: (destination: PreviewDestination) => void;
  onCalendar: (name: string) => void;
}) {
  const [kind, setKind] = useState("all");
  const scoped = destinations.filter((d) =>
    d.workspaceIds.some((id) => spaces.some((s) => s.id === id)),
  );
  const visible = scoped.filter((d) => kind === "all" || d.kind === kind);
  const counts = (name: string) =>
    publications.filter((p) => p.destination === name);
  return (
    <section>
      <div className="cp-section-heading">
        <div>
          <h2>{tr("发布渠道")}</h2>
          <p>{tr("自家站点、社交账号与论坛，都是作品的发布目的地。")}</p>
        </div>
        {!liveMode && <span className="cp-muted">{tr("账号与授权状态均为示例")}</span>}
      </div>
      <div className="cp-filter-row">
        <div className="cp-state-filters" aria-label={tr("按渠道类型筛选")}>
          {[
            ["all", "全部渠道"],
            ["owned", "自家站点"],
            ["external", "外部平台"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              <AppIcon
                name={
                  id === "owned" ? "home" : id === "external" ? "globe" : "grid"
                }
                size={15}
              />
              {tr(label)}
              <span>
                {scoped.filter((d) => id === "all" || d.kind === id).length}
              </span>
            </button>
          ))}
        </div>
        {tools ? (
          <div className="cp-channel-tools">{tools}</div>
        ) : (
          <span className="cp-muted">
            {tr("管理操作在浏览器中的线上中心完成")}
          </span>
        )}
      </div>
      <div className="cp-table-wrap">
        <table className="cp-channels-table">
          <thead>
            <tr>
              <th>{tr("平台与账号")}</th>
              <th>{tr("连接状态")}</th>
              <th>{tr("内容来源")}</th>
              <th>{tr("待发布")}</th>
              <th>{tr("待处理")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((d) => (
              <tr key={d.name}>
                <td>
                  <div className="cp-channel-identity">
                    <DestinationIcon
                      name={d.platform}
                      workspaceId={
                        d.kind === "owned" ? d.workspaceIds[0] : undefined
                      }
                      size={36}
                    />
                    <div>
                      <strong>{d.name}</strong>
                      <small>{d.account}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    className={
                      "cp-state " +
                      (d.state === "connected"
                        ? "cp-claimed"
                        : d.state === "needs_attention"
                          ? "cp-blocked"
                          : "")
                    }
                  >
                    {d.state === "connected"
                      ? tr("已连接")
                      : d.state === "needs_attention"
                        ? tr("需要检查")
                        : tr("未连接")}
                  </span>
                  <small>{d.auth}</small>
                </td>
                <td>
                  {d.workspaceIds
                    .map((id) => spaces.find((s) => s.id === id)?.name)
                    .filter(Boolean)
                    .join("、")}
                </td>
                <td>
                  {
                    counts(d.name).filter(
                      (p) => p.state === "planned" || p.state === "scheduled",
                    ).length
                  }
                </td>
                <td>
                  {counts(d.name).filter((p) => p.state === "blocked").length ||
                    "—"}
                </td>
                <td>
                  <button
                    className="cp-text-button"
                    onClick={() => onCalendar(d.name)}
                  >
                    <AppIcon name="clock" size={14} />
                    {tr("查看排期")}
                  </button>
                  <button
                    className="cp-text-button"
                    onClick={() => onManage(d)}
                  >
                    <AppIcon name="settings" size={14} />
                    {tr(tools ? "管理" : "管理入口 ↗")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <p className="cp-empty">{tr("当前范围没有对应渠道。")}</p>
        )}
      </div>
      <p className="cp-channels-note">
        {tr(
          "工作空间决定内容归属，渠道决定发到哪里。同一工作空间可以发布到多个账号，同一渠道也可以承接多个工作空间。",
        )}
      </p>
    </section>
  );
}
