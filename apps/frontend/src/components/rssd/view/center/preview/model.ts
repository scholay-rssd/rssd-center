// Frontend view model only. Wire contracts remain jointly owned with RSSD Center.
export type PreviewTab =
  | "overview"
  | "demands"
  | "works"
  | "calendar"
  | "channels"
  | "assistant"
  | "settings"
  | "legacy";
export type DemandState = "queued" | "claimed" | "completed" | "blocked";
export interface PreviewSpace {
  id: string;
  name: string;
  initial: string;
  target: number;
  completed: number;
  sections: string[];
}
export interface PreviewDemand {
  id: string;
  workspaceId: string;
  section: string;
  title: string;
  kind: "写作" | "翻译" | "补充更新";
  state: DemandState;
  priority: "优先" | "常规";
  due: string;
  languages: string[];
  owner?: string;
  angle: string;
  outline: string[];
  requirements: string;
  sources: string[];
}
export interface PreviewPublication {
  id: string;
  workId: string;
  workspaceId: string;
  title: string;
  destination: string;
  locale: string;
  date: string;
  time: string;
  state: "planned" | "ready" | "scheduled" | "published" | "blocked";
  /** The Center record behind a real calendar entry; absent in sample data. */
  record?: {
    source: "rssd" | "postiz";
    publicationId: string;
    scheduledAt: string;
    updatedAt: string;
    hasSchedule: boolean;
    /** Still queued at the Center, so its time can be changed. */
    canSchedule: boolean;
    /** Stopped at the Center and can be sent again under the same identity. */
    canRetry: boolean;
    error?: string;
    url?: string;
  };
}
export interface PreviewData {
  demandCounts?: Array<{workspaceId:string;state:string;count:number}>;
  spaces: PreviewSpace[];
  demands: PreviewDemand[];
  publications: PreviewPublication[];
  destinations: PreviewDestination[];
  weekStart: string;
}
export interface PreviewDestination {
  name: string;
  platform: string;
  kind: "owned" | "external";
  account: string;
  auth: string;
  state: "connected" | "needs_attention" | "not_connected";
  workspaceIds: string[];
  /** What a real entry stands for at the Center: a configured destination, or an authorized account not yet used by one. */
  record?: { destinationId?: string; integrationId?: string };
}
export const demandLabels: Record<DemandState, string> = {
  queued: "待领取",
  claimed: "进行中",
  completed: "已交稿",
  blocked: "待处理",
};
export const publicationLabels = {
  planned: "待生产",
  ready: "成品就绪",
  scheduled: "已排期",
  published: "已发布",
  blocked: "待处理",
};
export function dayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function addDays(key: string, days: number) {
  const date = new Date(key + "T12:00:00");
  date.setDate(date.getDate() + days);
  return dayKey(date);
}
export function monday(key: string) {
  const date = new Date(key + "T12:00:00");
  return addDays(key, -((date.getDay() + 6) % 7));
}
export function monthDays(key: string) {
  const date = new Date(key + "T12:00:00");
  date.setDate(1);
  const start = monday(dayKey(date));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

// These synthetic tasks contain no manuscripts, credentials or operational records.
export function createPreviewData(): PreviewData {
  const spaces: PreviewSpace[] = [
    {
      id: "academic",
      name: "今日学术",
      initial: "学",
      target: 12,
      completed: 7,
      sections: ["学界犀闻", "研究进展"],
    },
    {
      id: "metho",
      name: "研究方法",
      initial: "方",
      target: 8,
      completed: 3,
      sections: ["统计之美", "方法百科"],
    },
    {
      id: "enter",
      name: "恩特",
      initial: "恩",
      target: 6,
      completed: 4,
      sections: ["社区精选"],
    },
    {
      id: "legis",
      name: "法理",
      initial: "法",
      target: 4,
      completed: 2,
      sections: ["法律观察"],
    },
    {
      id: "lingxi",
      name: "灵犀",
      initial: "灵",
      target: 4,
      completed: 1,
      sections: ["日常观察"],
    },
    {
      id: "pets",
      name: "宠物",
      initial: "宠",
      target: 6,
      completed: 4,
      sections: ["宠物资讯"],
    },
    {
      id: "piggytuck",
      name: "PiggyTuck",
      initial: "P",
      target: 3,
      completed: 1,
      sections: ["生活方式"],
    },
    {
      id: "study",
      name: "Study",
      initial: "S",
      target: 4,
      completed: 2,
      sections: ["学习方法"],
    },
    {
      id: "xsiching",
      name: "Xsiching",
      initial: "X",
      target: 3,
      completed: 1,
      sections: ["观察"],
    },
    {
      id: "personal",
      name: "个人站",
      initial: "我",
      target: 2,
      completed: 1,
      sections: ["随笔"],
    },
  ];
  const seed: Array<
    [string, string, string, DemandState, string?, PreviewDemand["kind"]?]
  > = [
    ["academic", "学界犀闻", "开放评审：研究者如何回应公开的质疑", "queued"],
    [
      "metho",
      "统计之美",
      "置信区间到底能告诉我们什么",
      "claimed",
      "Windows · Codex",
    ],
    [
      "academic",
      "研究进展",
      "科研数据共享，从可下载到可复用",
      "claimed",
      "Grok · Codex",
    ],
    ["metho", "方法百科", "一次调查需要多少样本：从问题出发", "queued"],
    [
      "pets",
      "宠物资讯",
      "室内猫的环境丰富化：从观察开始",
      "completed",
      "Mac mini · Cursor",
    ],
    [
      "enter",
      "社区精选",
      "把讨论整理成可以继续生长的知识",
      "blocked",
      "Grok · Codex",
    ],
    [
      "metho",
      "统计之美",
      "Understanding confidence intervals",
      "queued",
      undefined,
      "翻译",
    ],
    ["legis", "法律观察", "数据使用中的告知与同意", "queued"],
    [
      "lingxi",
      "日常观察",
      "如何记录一次有效的访谈",
      "completed",
      "Windows · Codex",
    ],
    ["academic", "学界犀闻", "预注册之后，研究计划还可以修改吗", "queued"],
    ["study", "学习方法", "间隔复习：把反馈放进学习计划", "queued"],
  ];
  const demands = seed.map(
    ([workspaceId, section, title, state, owner, kind], i): PreviewDemand => ({
      id: "demo-demand-" + i,
      workspaceId,
      section,
      title,
      state,
      owner,
      kind: kind || "写作",
      priority: i < 4 ? "优先" : "常规",
      due: "2026-11-" + String(3 + (i % 5)).padStart(2, "0"),
      languages: kind === "翻译" ? ["English"] : ["中文", "English"],
      angle:
        "从读者会遇到的一个具体问题开始，解释判断过程与适用边界，给出可以继续查证的线索。",
      outline: [
        "用一个具体场景提出问题",
        "解释关键概念与判断依据",
        "给出案例、限制和可操作建议",
        "整理原始来源与延伸阅读",
      ],
      requirements:
        "完整正文与必要配图；语言清楚，区分研究结论与推测。沿用当前栏目的品牌信息和写作规范。",
      sources: [
        "优先核对原始研究或官方资料",
        "本页为交互示例，参考来源待正式任务提供",
      ],
    }),
  );
  const publications: PreviewPublication[] = [
    {
      id: "demo-p1",
      workId: "demo-work-1",
      workspaceId: "academic",
      title: "开放评审：研究者如何回应公开的质疑",
      destination: "今日学术 · 网站",
      locale: "中文",
      date: "2026-11-02",
      time: "09:00",
      state: "planned",
    },
    {
      id: "demo-p2",
      workId: "demo-work-2",
      workspaceId: "metho",
      title: "置信区间到底能告诉我们什么",
      destination: "研究方法 · 网站",
      locale: "中文",
      date: "2026-11-03",
      time: "10:00",
      state: "scheduled",
    },
    {
      id: "demo-p3",
      workId: "demo-work-2",
      workspaceId: "metho",
      title: "Understanding confidence intervals",
      destination: "研究方法 · 网站",
      locale: "English",
      date: "2026-11-03",
      time: "16:00",
      state: "planned",
    },
    {
      id: "demo-p4",
      workId: "demo-work-2",
      workspaceId: "metho",
      title: "Understanding confidence intervals",
      destination: "LinkedIn",
      locale: "English",
      date: "2026-11-04",
      time: "10:00",
      state: "planned",
    },
    {
      id: "demo-p5",
      workId: "demo-work-3",
      workspaceId: "pets",
      title: "室内猫的环境丰富化：从观察开始",
      destination: "宠物 · 网站",
      locale: "中文",
      date: "2026-11-04",
      time: "09:30",
      state: "published",
    },
    {
      id: "demo-p6",
      workId: "demo-work-4",
      workspaceId: "enter",
      title: "把讨论整理成可以继续生长的知识",
      destination: "Discourse",
      locale: "中文",
      date: "2026-11-05",
      time: "14:00",
      state: "blocked",
    },
    {
      id: "demo-p7",
      workId: "demo-work-5",
      workspaceId: "academic",
      title: "科研数据共享，从可下载到可复用",
      destination: "今日学术 · 网站",
      locale: "中文",
      date: "2026-11-06",
      time: "09:00",
      state: "scheduled",
    },
    {
      id: "demo-p8",
      workId: "demo-work-6",
      workspaceId: "lingxi",
      title: "如何记录一次有效的访谈",
      destination: "灵犀 · 网站",
      locale: "中文",
      date: "2026-11-07",
      time: "11:00",
      state: "published",
    },
  ];
  publications.push(
    {
      id: "demo-p9",
      workId: "demo-work-3",
      workspaceId: "pets",
      title: "室内猫的环境丰富化：从观察开始",
      destination: "Facebook",
      locale: "English",
      date: "2026-11-04",
      time: "18:00",
      state: "scheduled",
    },
    {
      id: "demo-p10",
      workId: "demo-work-5",
      workspaceId: "academic",
      title: "科研数据共享，从可下载到可复用",
      destination: "X",
      locale: "English",
      date: "2026-11-06",
      time: "16:00",
      state: "blocked",
    },
  );
  const destinations: PreviewDestination[] = [
    ...spaces.map(
      (s): PreviewDestination => ({
        name: s.name + " · 网站",
        platform: "RSSD Web",
        kind: "owned",
        account: s.name,
        auth: "站点专用凭据",
        state: "connected",
        workspaceIds: [s.id],
      }),
    ),
    {
      name: "Facebook",
      platform: "Facebook",
      kind: "external",
      account: "RSSD Pets · 示例主页",
      auth: "平台账号授权",
      state: "connected",
      workspaceIds: ["pets"],
    },
    {
      name: "LinkedIn",
      platform: "LinkedIn",
      kind: "external",
      account: "RSSD Research · 示例账号",
      auth: "平台账号授权",
      state: "connected",
      workspaceIds: ["academic", "metho"],
    },
    {
      name: "X",
      platform: "X",
      kind: "external",
      account: "RSSD Academic · 示例账号",
      auth: "平台账号授权",
      state: "needs_attention",
      workspaceIds: ["academic"],
    },
    {
      name: "Telegram",
      platform: "Telegram",
      kind: "external",
      account: "尚未选择账号",
      auth: "机器人凭据",
      state: "not_connected",
      workspaceIds: ["academic", "metho"],
    },
    {
      name: "Discourse",
      platform: "Discourse",
      kind: "external",
      account: "恩特论坛 · 示例连接",
      auth: "API Key",
      state: "needs_attention",
      workspaceIds: ["enter"],
    },
  ];
  return {
    spaces,
    demands,
    publications,
    destinations,
    weekStart: "2026-11-02",
  };
}
