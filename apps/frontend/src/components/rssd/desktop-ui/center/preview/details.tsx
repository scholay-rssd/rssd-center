// Task and publication drawers.
import { useState } from "react";
import { tr } from "../../uiText";
import {
  demandLabels,
  publicationLabels,
  type PreviewDemand,
  type PreviewPublication,
  type PreviewSpace,
} from "./model";
import { Drawer } from "./parts";

export function TaskDetail({
  task,
  space,
  onClose,
  onUpdate,
  onClaim,
  liveMode=false,
}: {
  liveMode?: boolean;
  task: PreviewDemand;
  space: PreviewSpace;
  onClose: () => void;
  onUpdate: (task: PreviewDemand) => void;
  /** Absent where tasks cannot be started from this screen. */
  onClaim?: () => void;
}) {
  const [priority, setPriority] = useState(task.priority),
    [due, setDue] = useState(task.due);
  const editable = task.state === "queued";
  return (
    <Drawer title={tr(liveMode?"任务详情":"任务详情 · 示例")} onClose={onClose}>
      <div className="cp-detail-body">
        <div className="cp-eyebrow">
          {space.name} / {task.section}
        </div>
        <h2>{task.title}</h2>
        <div className="cp-detail-meta">
          <span className={"cp-state cp-" + task.state}>
            {tr(demandLabels[task.state])}
          </span>
          <span>{tr(task.kind)}</span>
          <span>{task.languages.join(" / ")}</span>
        </div>
        <dl className="cp-facts">
          <dt>{tr("执行设备")}</dt>
          <dd>{task.owner || tr("等待设备认领")}</dd>
          <dt>{tr("任务编号")}</dt>
          <dd>{task.id}</dd>
          <dt>{tr("计划交稿")}</dt>
          <dd>{task.due}</dd>
        </dl>
        <section>
          <h3>{tr("写作角度")}</h3>
          <p>{task.angle}</p>
        </section>
        <section>
          <h3>{tr("初始提纲")}</h3>
          <ol>
            {task.outline.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </section>
        <section>
          <h3>{tr("交付要求")}</h3>
          <p>{task.requirements}</p>
        </section>
        <section>
          <h3>{tr("参考线索")}</h3>
          <ul>
            {task.sources.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (editable) onUpdate({ ...task, priority, due });
          }}
          className="cp-detail-form"
        >
          <h3>{tr("调整任务")}</h3>
          {!editable && (
            <p className="cp-muted">
              {tr("已进入执行的任务保持原要求。本页仍可查看认领时的任务说明。")}
            </p>
          )}
          <div>
            <label>
              {tr("优先级")}
              <select
                disabled={!editable}
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as PreviewDemand["priority"])
                }
              >
                <option value="常规">{tr("常规")}</option>
                <option value="优先">{tr("优先")}</option>
              </select>
            </label>
            <label>
              {tr("计划交稿")}
              <input
                type="date"
                required
                disabled={!editable}
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
          </div>
          <footer>
            {onClaim && (
              <button type="button" disabled={!editable} onClick={onClaim}>
                {tr(liveMode?"本机认领并执行":"模拟认领")}
              </button>
            )}
            <button className="cp-primary" disabled={!editable}>
              {tr(liveMode?"保存到中心":"应用到预览")}
            </button>
          </footer>
        </form>
      </div>
    </Drawer>
  );
}

export function PublicationDetail({
  item,
  liveMode=false,
  space,
  onClose,
  onUpdate,
}: {
  liveMode?: boolean;
  item: PreviewPublication;
  space: PreviewSpace;
  onClose: () => void;
  onUpdate: (item: PreviewPublication) => void;
}) {
  const [date, setDate] = useState(item.date),
    [time, setTime] = useState(item.time);
  const editable = item.state === "scheduled" || item.state === "planned";
  return (
    <Drawer title={tr(liveMode?"发布详情":"发布详情 · 示例")} onClose={onClose}>
      <div className="cp-detail-body">
        <div className="cp-eyebrow">
          {space.name} / {item.locale}
        </div>
        <h2>{item.title}</h2>
        <span className={"cp-state cp-" + item.state}>
          {tr(publicationLabels[item.state])}
        </span>
        <dl className="cp-facts">
          <dt>{tr("发布目的地")}</dt>
          <dd>{item.destination}</dd>
          <dt>{tr("作品身份")}</dt>
          <dd>{item.workId}</dd>
          <dt>{tr("计划发布时间")}</dt>
          <dd>
            {item.date} {item.time}
          </dd>
        </dl>
        <p className="cp-muted">
          {liveMode?tr("状态来自中心。请在原发布入口查看完整回执与调整排期。"):item.state === "planned"
            ? tr("这是一项待生产计划，尚未具备可发布成品。")
            : item.state === "blocked"
              ? tr("示例异常：目的地暂不可用，原发布身份保持不变。")
              : item.state === "published"
                ? tr("此处展示已发布记录的详情样式，数据为示例。")
                : tr("成品已准备好，等待计划时间。此状态为界面示例。")}
        </p>
        <form
          className="cp-detail-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (editable || liveMode) onUpdate({ ...item, date, time });
          }}
        >
          <h3>{tr("调整排期")}</h3>
          <div>
            <label>
              {tr("日期")}
              <input
                type="date"
                value={date}
                required
                disabled={!editable || liveMode}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label>
              {tr("时间")}
              <input
                type="time"
                value={time}
                required
                disabled={!editable || liveMode}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
          </div>
          <footer>
            <button className="cp-primary" disabled={!editable && !liveMode}>
              {tr(liveMode?"在中心处理原发布":"应用到预览")}
            </button>
          </footer>
        </form>
      </div>
    </Drawer>
  );
}
