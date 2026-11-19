import type { ExplainContext, TokenLog, TxRecord } from "@qorewatch/core";
import type { Watch } from "../db/store.js";

/**
 * Alert categories. Users mute categories per chat or per address. "security" alerts
 * of level "critical" always come through: muting, quiet hours and pausing cannot hide
 * a key change or a takeover sign.
 */
export const CATEGORIES = ["money", "security", "activity", "staking", "governance", "network", "pools"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  money: "Money in and out",
  security: "Security (keys, windows, permissions)",
  activity: "Account activity (failed transactions, swaps, contract calls)",
  staking: "Staking",
  governance: "Governance",
  network: "Network notices (upgrades)",
  pools: "Pool price alerts",
};

export type Level = "critical" | "warning" | "info";

export interface Button {
  text: string;
  url?: string;
  /** Callback data (max 64 bytes). */
  data?: string;
}

export interface Alert {
  /** De-duplication key: the same key is delivered to a chat at most once. */
  key: string;
  category: Category;
  level: Level;
  /** The watched address this alert concerns (routing, thresholds, per-address mutes). */
  address?: string;
  /** For money alerts: the amount in uqor equivalent, compared with the watch threshold. */
  amountUqor?: bigint;
  /** Short HTML headline, starting with an emoji. */
  title: string;
  /** HTML lines. */
  body: string[];
  buttons?: Button[][];
  txHash?: string;
}

/** What detectors can use: explanations (with the chat's labels), chain settings, pages. */
export interface DetectContext {
  explain: ExplainContext;
  /** The watch this run is for (address, label, owned). */
  watch: Watch;
  height: number;
  blockSeconds: number;
  publicUrl: string;
  explorer: string;
}

/** A detector looks at one transaction for one watched address and returns alerts. */
export interface TxDetector {
  id: string;
  detect(tx: TxRecord, ctx: DetectContext): Promise<Alert[]>;
}

/** A detector for EVM token logs. */
export interface LogDetector {
  id: string;
  detect(log: TokenLog, ctx: DetectContext): Promise<Alert[]>;
}
