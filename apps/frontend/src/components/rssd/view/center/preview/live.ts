import type { ReactNode } from "react";
import type { PreviewData, PreviewDemand, PreviewDestination, PreviewPublication } from "./model";

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
  /** The assistant tab; absent where no assistant can run (the browser). */
  assistant?: (workspaceIds:string[])=>ReactNode;
  /** Shell controls shown at the right of the top bar. */
  tools?: ReactNode;
  /** The works library and editor tab; receives whether it is open and stays mounted. */
  works?: (shown:boolean)=>ReactNode;
  /** The settings tab; receives whether it is open and stays mounted. */
  settings?: (shown:boolean)=>ReactNode;
  /** Drawers the Center opens itself; drawn inside the view so they share its palette. */
  overlays?: ReactNode;
  /** Open the form that adds a task to the pool. */
  newDemand?: () => void;
  /** Give a claimed or stopped task back to the pool. */
  releaseDemand?: (task: PreviewDemand) => Promise<void>;
  /** Actions shown beside the channel filters. */
  channelTools?: ReactNode;
  /** Open the configuration of one channel. */
  manageChannel?: (destination: PreviewDestination) => void;
  /** Change when a queued publication goes out. */
  schedule?: (item: PreviewPublication, scheduledAt: string) => Promise<void>;
  /** Send a stopped publication again under its original identity. */
  retry?: (item: PreviewPublication) => Promise<void>;
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
