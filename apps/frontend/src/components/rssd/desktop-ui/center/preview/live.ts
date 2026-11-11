import type { ReactNode } from "react";
import type { PreviewData, PreviewDemand } from "./model";

/** What the scheduling view needs from a real Center; without it the view runs on sample data. */
export interface LiveCenterActions {
  data: PreviewData;
  loading: boolean;
  error: string;
  refresh: () => void;
  updateDemand: (task: PreviewDemand) => Promise<void>;
  /** Start this task on this machine. Absent where there is no local worker (the online Center). */
  claim?: (task: PreviewDemand) => Promise<void>;
  manage: (tab: string, workspaceId?: string) => void;
  assistant: (workspaceIds:string[])=>ReactNode;
  calendarRange: (from:string,to:string)=>void;
  /** Works library and local execution, shown as a last tab; receives whether that tab is open. */
  legacy?: (shown:boolean)=>ReactNode;
  /** Name of that last tab; defaults to the desktop's works and local execution. */
  legacyLabel?: string;
  /** What this machine is doing, and anything it is holding that needs a decision. */
  execution?: {running:boolean;label:string;notes:string[]};
  /** Ask the Center for tasks matching the text; `appliedSearch` is the text the loaded tasks answer. */
  search?: (text:string)=>void;
  appliedSearch?: string;
  /** Present while the Center holds more tasks than are loaded. */
  loadMore?: ()=>void;
  calendarTruncated?: boolean;
}
