// The assistant tab of the sample-data preview. A real Center supplies its own assistant.
import type { Dispatch, RefObject, SetStateAction } from "react";
import { tr } from "../../uiText";
import { Icon } from "./parts";
import { NavigationIcon } from "./PreviewIcons";

export type SampleTurn = { id: number; text: string; scope: string; agent: string };
export default function SampleAssistant({
  messagesRef,
  conversation,
  setConversation,
  message,
  setMessage,
  agent,
  setAgent,
  scope,
  scopeName,
}: {
  messagesRef: RefObject<HTMLDivElement | null>;
  conversation: SampleTurn[];
  setConversation: Dispatch<SetStateAction<SampleTurn[]>>;
  message: string;
  setMessage: (text: string) => void;
  agent: string;
  setAgent: (name: string) => void;
  scope: string[];
  scopeName: string;
}) {
  return (
    <div className="cp-assistant">
      <section className="cp-conversation">
        <div className="cp-section-heading">
          <div>
            <h2>{tr("中心助手")}</h2>
            <p>{tr("用本机智能体查看和调整同一个线上中心。")}</p>
          </div>
          <span className="cp-state">{tr("交互预览")}</span>
        </div>
        <div ref={messagesRef} className="cp-messages" aria-live="polite">
          {conversation.length === 0 ? (
            <div className="cp-assistant-welcome">
              <div className="cp-assistant-mark">
                <NavigationIcon tab="assistant" />
              </div>
              <h3>{tr("从目标开始安排生产")}</h3>
              <p>
                {tr("可以查看各站进度、调整选题方向，或检查下一次发布。")}
              </p>
              <div className="cp-suggestions">
                {[
                  "看看各栏目这周还缺多少内容",
                  "研究方法站优先安排两篇统计方法",
                  "检查明天自家站点和外部渠道的排期",
                ].map((text) => (
                  <button key={text} onClick={() => setMessage(tr(text))}>
                    {tr(text)}
                    <Icon kind="arrow" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            conversation.map((item) => (
              <div className="cp-conversation-turn" key={item.id}>
                <div className="cp-user-message">
                  <small>
                    {tr("你 · {{scope}}", { scope: item.scope })}
                  </small>
                  <p>{item.text}</p>
                </div>
                <div className="cp-agent-message">
                  <small>
                    {tr("{{agent}} · 示例回复", { agent: item.agent })}
                  </small>
                  <p>
                    {tr(
                      "这条指令已显示在预览中。正式接通后，会在这里展示查询范围、工具调用和中心返回的结果。",
                    )}
                  </p>
                  <details>
                    <summary>{tr("查看执行过程的展示样例")}</summary>
                    <ol>
                      <li>{tr("读取当前目标与已有作品")}</li>
                      <li>
                        {tr("核对尚未领取、正在执行和已经完成的任务")}
                      </li>
                      <li>{tr("通过中心接口提交调整，展示实际回执")}</li>
                    </ol>
                    <p>
                      {tr(
                        "以上仅为展示样例，本次没有调用工具或修改中心。",
                      )}
                    </p>
                  </details>
                </div>
              </div>
            ))
          )}
        </div>
        <form
          className="cp-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim() || !scope.length) return;
            setConversation((old) => [
              ...old,
              {
                id: old.length + 1,
                text: message.trim(),
                scope: scopeName,
                agent,
              },
            ]);
            setMessage("");
          }}
        >
          <label className="cp-sr-only" htmlFor="cp-instruction">
            {tr("给中心助手的指令")}
          </label>
          <textarea
            id="cp-instruction"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={tr("告诉助手，你想怎样调整内容生产…")}
          />
          <div>
            <label>
              {tr("本机智能体")}
              <select
                aria-label={tr("预览智能体")}
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                <option>Codex</option>
                <option>Cursor</option>
              </select>
            </label>
            <span>{scopeName}</span>
            <button
              className="cp-primary"
              disabled={!message.trim() || !scope.length}
            >
              {tr("预览发送")}
              <Icon kind="send" />
            </button>
          </div>
        </form>
        <p className="cp-composer-note">
          {tr("当前只预览对话流程，尚未连接智能体或发送到中心。")}
        </p>
      </section>
      <aside className="cp-assistant-context">
        <h3>{tr("当前上下文")}</h3>
        <dl>
          <dt>{tr("工作范围")}</dt>
          <dd>{scopeName}</dd>
          <dt>{tr("管理对象")}</dt>
          <dd>{tr("目标、需求池、发布安排")}</dd>
          <dt>{tr("中心连接")}</dt>
          <dd>{tr("示例连接")}</dd>
          <dt>{tr("执行位置")}</dt>
          <dd>{tr("本机智能体")}</dd>
        </dl>
        <section>
          <h3>{tr("线上常驻助手")}</h3>
          <p>
            {tr(
              "持续维护目标与需求池。桌面发出的调整在中心保存后，线上助手沿用同一份安排。",
            )}
          </p>
          <span className="cp-muted">{tr("运行状态等待中心接入")}</span>
        </section>
        <section>
          <h3>{tr("操作结果")}</h3>
          <p>
            {tr(
              "每次调整保留原因与结果，任务认领和发布状态以中心回执为准。",
            )}
          </p>
        </section>
      </aside>
    </div>
  );
}
