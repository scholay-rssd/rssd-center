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
  onSchedule,
  onRetry,
}: {
  liveMode?: boolean;
  item: PreviewPublication;
  space: PreviewSpace;
  onClose: () => void;
  onUpdate: (item: PreviewPublication) => void;
  /** Saves a new time at the Center; rejects with the Center's reason. */
  onSchedule?: (scheduledAt: string) => Promise<void>;
  onRetry?: () => Promise<void>;
}) {
  const [date, setDate] = useState(item.date),
    [time, setTime] = useState(item.time);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const record = item.record;
  const editable = record
    ? record.canSchedule && Boolean(onSchedule)
    : item.state === "scheduled" || item.state === "planned";
  // The drawer stays open on a refusal so the chosen time is not lost.
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    work()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
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
          <dt>{tr(record && !record.hasSchedule ? "进入队列时间" : "计划发布时间")}</dt>
          <dd>
            {item.date} {item.time}
          </dd>
          {record?.error && (
            <>
              <dt>{tr("待处理原因")}</dt>
              <dd>{record.error}</dd>
            </>
          )}
        </dl>
        <p className="cp-muted">
          {record
            ? record.source === "postiz"
              ? tr("这是发布工具中的原生帖子，内容和时间在其编辑器中修改。")
              : record.canSchedule
                ? tr("成品已在中心排队。调整时间不会创建新的发布请求。")
                : item.state === "blocked"
                  ? tr("发布在目的地停止，原发布身份保持不变。")
                  : item.state === "published"
                    ? tr("已发布，回执来自目的地。")
                    : tr("此发布已开始发送，时间不可再调整。")
            : item.state === "planned"
            ? tr("这是一项待生产计划，尚未具备可发布成品。")
            : item.state === "blocked"
              ? tr("示例异常：目的地暂不可用，原发布身份保持不变。")
              : item.state === "published"
                ? tr("此处展示已发布记录的详情样式，数据为示例。")
                : tr("成品已准备好，等待计划时间。此状态为界面示例。")}
        </p>
        {error && (
          <p role="alert" className="cp-notice">
            {error}
          </p>
        )}
        {(!record || record.canSchedule) && (
          <form
            className="cp-detail-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!editable) return;
              if (!record) return onUpdate({ ...item, date, time });
              const instant = new Date(date + "T" + time);
              if (!Number.isFinite(instant.getTime()))
                return setError(tr("请选择有效的发布时间"));
              run(() => onSchedule!(instant.toISOString()));
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
                  disabled={!editable || busy}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <label>
                {tr("时间")}
                <input
                  type="time"
                  value={time}
                  required
                  disabled={!editable || busy}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
            </div>
            <footer>
              <button className="cp-primary" disabled={!editable || busy}>
                {tr(record ? "保存排期" : "应用到预览")}
              </button>
            </footer>
          </form>
        )}
        {record && (record.url || record.source === "postiz" || (record.canRetry && onRetry)) && (
          <div className="cp-detail-actions">
            {record.canRetry && onRetry && (
              <button disabled={busy} onClick={() => run(onRetry)}>
                {tr("恢复原发布")}
              </button>
            )}
            {record.url && (
              <a href={record.url} target="_blank" rel="noreferrer">
                {tr("查看成品")} ↗
              </a>
            )}
            {record.source === "postiz" && (
              <a href="/launches">{tr("在发布工具中打开")} ↗</a>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
