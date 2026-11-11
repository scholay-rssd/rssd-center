import { tr } from "../../uiText";
import type { LiveCenterActions } from "./live";
import { monday, publicationLabels, type PreviewData, type PreviewPublication } from "./model";
import { Empty, shortDate } from "./parts";
import { DestinationIcon } from "./PreviewIcons";

export type CalendarView = "week" | "month" | "list";
export default function CalendarTab({
  live,
  data,
  calendarItems,
  days,
  date,
  setDate,
  calendarView,
  setCalendarView,
  destination,
  setDestination,
  moveCalendar,
  setSelectedPublication,
}: {
  live?: LiveCenterActions;
  data: PreviewData;
  /** Publications in the shown period, already narrowed by workspace and destination. */
  calendarItems: PreviewPublication[];
  days: string[];
  date: string;
  setDate: (day: string) => void;
  calendarView: CalendarView;
  setCalendarView: (view: CalendarView) => void;
  destination: string;
  setDestination: (name: string) => void;
  moveCalendar: (direction: number) => void;
  setSelectedPublication: (id: string) => void;
}) {
  return (
    <>
      <div className="cp-section-heading">
        <div>
          <h2>{tr("发布日历")}</h2>
          <p>
            {tr("自家站点与外部渠道统一查看，每次发布关联同一件作品。")}
          </p>
        </div>
        <label className="cp-destination">
          {tr("目的地")}
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="all">{tr("全部目的地")}</option>
            <option value="owned">{tr("自家站点")}</option>
            <option value="external">{tr("外部平台")}</option>
            {[
              ...new Set(data.publications.map((p) => p.destination)),
            ].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="cp-calendar-toolbar">
        <div className="cp-calendar-date">
          <button
            aria-label={tr("上一时段")}
            onClick={() => moveCalendar(-1)}
          >
            ‹
          </button>
          <strong>
            {calendarView === "month"
              ? `${date.slice(0, 4)} / ${Number(date.slice(5, 7))}`
              : `${shortDate(days[0])} — ${shortDate(days[6])}`}
          </strong>
          <button
            aria-label={tr("下一时段")}
            onClick={() => moveCalendar(1)}
          >
            ›
          </button>
          <button onClick={() => setDate(data.weekStart)}>
            {tr(live ? "本周" : "演示周")}
          </button>
        </div>
        <div className="cp-view-switch" aria-label={tr("日历视图")}>
          {[
            ["week", "周"],
            ["month", "月"],
            ["list", "列表"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={calendarView === id}
              onClick={() => {
                setCalendarView(id as typeof calendarView);
                if (id !== "month") setDate(monday(date));
              }}
            >
              {tr(label)}
            </button>
          ))}
        </div>
      </div>
      {calendarView === "list" ? (
        <div className="cp-calendar-list">
          {calendarItems.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPublication(p.id)}
            >
              <time>
                {shortDate(p.date)}
                <b>{p.time}</b>
              </time>
              <span>
                <strong>{p.title}</strong>
                <small className="cp-destination-label">
                  <DestinationIcon
                    name={p.destination}
                    workspaceId={p.workspaceId}
                    size={20}
                  />
                  {p.destination} · {p.locale}
                </small>
              </span>
              <span className={"cp-state cp-" + p.state}>
                {tr(publicationLabels[p.state])}
              </span>
            </button>
          ))}
          {!calendarItems.length && (
            <Empty
              title={tr("当前时段没有发布安排")}
              text={tr("可切换日期、目的地或工作空间。")}
            />
          )}
        </div>
      ) : (
        <div className="cp-calendar-scroll">
          <div className={"cp-calendar cp-calendar-" + calendarView}>
            <div className="cp-weekdays">
              {[
                "周一",
                "周二",
                "周三",
                "周四",
                "周五",
                "周六",
                "周日",
              ].map((day) => (
                <span key={day}>{tr(day)}</span>
              ))}
            </div>
            <div className="cp-calendar-grid">
              {days.map((day) => (
                <section
                  key={day}
                  className={
                    day.slice(0, 7) !== date.slice(0, 7)
                      ? "cp-outside-month"
                      : ""
                  }
                  aria-label={day}
                >
                  <header>
                    <time dateTime={day}>{Number(day.slice(8))}</time>
                    <span>
                      {calendarItems.filter((p) => p.date === day)
                        .length || ""}
                    </span>
                  </header>
                  {calendarItems
                    .filter((p) => p.date === day)
                    .map((p) => (
                      <button
                        className={"cp-event cp-event-" + p.state}
                        key={p.id}
                        onClick={() => setSelectedPublication(p.id)}
                      >
                        <span>
                          <time>{p.time}</time>
                          <small>{tr(publicationLabels[p.state])}</small>
                        </span>
                        <strong>{p.title}</strong>
                        <small className="cp-destination-label">
                          <DestinationIcon
                            name={p.destination}
                            workspaceId={p.workspaceId}
                            size={20}
                          />
                          {p.destination}
                        </small>
                        <em>{p.locale}</em>
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="cp-calendar-legend">
        <span>
          <i className="planned" />
          {tr("待生产")}
        </span>
        <span>
          <i />
          {tr("已排期")}
        </span>
        <span>
          <i className="published" />
          {tr("已发布")}
        </span>
        <span>
          <i className="blocked" />
          {tr("待处理")}
        </span>
        <small>{live
          ? tr("展示时区：{{timezone}} · 中心真实数据", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          : tr("展示时区：Asia/Shanghai · 数据为示例")}</small>
      </div>
      {live?.calendarTruncated && (
        <p className="cp-list-footer">
          {tr("当前显示前 200 条发布记录。")}
          <button onClick={() => live.manage("calendar")}>
            {tr("打开中心分页查看全部")}
          </button>
        </p>
      )}
    </>
  );
}
