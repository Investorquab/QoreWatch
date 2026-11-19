import { buildTx, qorToEvm, evmToQor, isAccount, type TokenLog, type TxRecord } from "@qorewatch/core";
import type { Chain } from "../chain.js";
import type { Store, Watch } from "../db/store.js";
import type { Deliverer } from "../alerts/deliver.js";
import type { Messenger } from "../telegram/messenger.js";
import type { Logger } from "../log.js";
import type { DetectContext, LogDetector, TxDetector } from "../alerts/types.js";
import { LOG_DETECTORS, TX_DETECTORS } from "../alerts/detectors/index.js";
import { labeller } from "../lookups.js";
import { handleLinkTx } from "../linking.js";

export interface WatcherStatus {
  height?: number;
  chainHeight?: number;
  lagBlocks?: number;
  startedAt: string;
  lastError?: string;
  blocksProcessed: number;
  alertsSent: number;
}

/** Extra per-transaction handlers (e.g. attestations) plugged in without changing the watcher. */
export type TxHook = (tx: TxRecord) => Promise<void>;

export interface WatcherDeps {
  chain: Chain;
  store: Store;
  deliverer: Deliverer;
  messenger: Messenger;
  log: Logger;
  publicUrl: string;
  maxCatchupBlocks: number;
  /** Blocks fetched in parallel per batch. */
  batch?: number;
  txDetectors?: TxDetector[];
  logDetectors?: LogDetector[];
  txHooks?: TxHook[];
}

/** Warn this many seconds before a spending window expires. */
const WINDOW_WARN_SECONDS = 30 * 60;

/**
 * Follows the chain block by block. For each transaction it finds the watched addresses
 * involved, runs every detector for every chat watching them, and hands alerts to the
 * Deliverer. The cursor is saved after each block, and alerts carry de-duplication keys,
 * so a restart resumes exactly where it stopped without repeating alerts.
 */
export class Watcher {
  readonly status: WatcherStatus = { startedAt: new Date().toISOString(), blocksProcessed: 0, alertsSent: 0 };
  private running = false;
  private readonly txDetectors: TxDetector[];
  private readonly logDetectors: LogDetector[];

  constructor(private readonly d: WatcherDeps) {
    this.txDetectors = d.txDetectors ?? TX_DETECTORS;
    this.logDetectors = d.logDetectors ?? LOG_DETECTORS;
  }

  /** Where to start: the saved cursor, or the chain head on a first run; never more than maxCatchupBlocks behind. */
  async init(): Promise<void> {
    const head = (await this.d.chain.rpc.status()).height;
    let cur = this.d.store.cursor("native");
    if (cur === undefined) {
      cur = head - 1;
      this.d.log.info("first start: following from the chain head", { height: head });
    } else if (head - cur > this.d.maxCatchupBlocks) {
      this.d.log.warn("far behind, skipping ahead", { from: cur, to: head - this.d.maxCatchupBlocks });
      cur = head - this.d.maxCatchupBlocks;
    }
    this.d.store.setCursor("native", cur);
    if (this.d.store.cursor("evm") === undefined || this.d.store.cursor("evm")! < cur) this.d.store.setCursor("evm", cur);
    this.status.height = cur;
    this.status.chainHeight = head;
  }

  /** Process what is available now. Returns the number of blocks processed. */
  async tick(maxBlocks = 40): Promise<number> {
    const head = (await this.d.chain.rpc.status()).height;
    this.status.chainHeight = head;
    let cur = this.d.store.cursor("native")!;
    const target = Math.min(head, cur + maxBlocks);
    const batch = this.d.batch ?? 4;
    let n = 0;
    while (cur < target) {
      const heights = Array.from({ length: Math.min(batch, target - cur) }, (_, i) => cur + 1 + i);
      const blocks = await Promise.all(heights.map((h) => this.d.chain.rpc.blockTxs(h)));
      for (const b of blocks) {
        await this.processBlock(b.height, b.txs);
        this.d.store.setCursor("native", b.height);
        cur = b.height;
        n++;
      }
    }
    await this.scanLogs(cur);
    this.status.height = cur;
    this.status.lagBlocks = head - cur;
    this.status.blocksProcessed += n;
    return n;
  }

  async processBlock(height: number, raws: Awaited<ReturnType<Chain["rpc"]["blockTxs"]>>["txs"]): Promise<void> {
    if (!raws.length) return;
    const watched = this.d.store.watchedAddresses();
    for (const raw of raws) {
      let tx: TxRecord;
      try {
        tx = await buildTx(raw);
      } catch (e) {
        this.d.log.warn("could not decode a transaction", { height, index: raw.index, error: (e as Error).message });
        continue;
      }
      await this.processTx(tx, watched, height);
    }
  }

  async processTx(tx: TxRecord, watched = this.d.store.watchedAddresses(), height = tx.height): Promise<void> {
    if (tx.memo.includes("QoreWatch link")) {
      const r = await handleLinkTx(tx, this.d.store, this.d.messenger, this.d.publicUrl);
      if (r.linked) watched.add(r.address);
      this.d.log.info("link transaction", { outcome: r.linked ? "linked" : r.reason });
    }
    for (const hook of this.d.txHooks ?? []) await hook(tx).catch((e) => this.d.log.warn("tx hook failed", { error: (e as Error).message }));
    const hits = tx.addresses.filter((a) => watched.has(a));
    if (!hits.length) return;
    this.schedule(tx, hits);
    for (const address of hits) {
      for (const w of this.d.store.watchersOf(address)) {
        const ctx = this.context(w, height);
        for (const det of this.txDetectors) {
          let alerts;
          try {
            alerts = await det.detect(tx, ctx);
          } catch (e) {
            this.d.log.warn("detector failed", { detector: det.id, error: (e as Error).message });
            continue;
          }
          await this.deliver(w, alerts);
        }
      }
    }
  }

  /** EVM token logs from the last scanned block up to `to`. */
  async scanLogs(to: number): Promise<void> {
    const from = (this.d.store.cursor("evm") ?? to) + 1;
    if (from > to) return;
    const end = Math.min(to, from + this.d.chain.cfg.maxLogRange - 1);
    const watched = this.d.store.watchedAddresses();
    let logs: TokenLog[] = [];
    if (watched.size) logs = await this.d.chain.evm.tokenLogs(from, end);
    const evmWatched = new Map<string, string>();
    for (const a of watched) if (isAccount(a)) evmWatched.set(qorToEvm(a), a);
    for (const log of logs) {
      const parties = log.kind === "token_transfer" ? [log.from, log.to] : log.kind === "token_approval" ? [log.owner] : [log.owner];
      if (log.kind === "token_approval" && evmWatched.has(log.owner)) this.d.store.setApproval(log.owner, log.token, log.spender, log.value, log.block, log.txHash);
      for (const p of new Set(parties)) {
        const qor = evmWatched.get(p);
        if (!qor) continue;
        for (const w of this.d.store.watchersOf(qor)) {
          const ctx = this.context(w, log.block);
          for (const det of this.logDetectors) {
            try {
              await this.deliver(w, await det.detect(log, ctx));
            } catch (e) {
              this.d.log.warn("log detector failed", { detector: det.id, error: (e as Error).message });
            }
          }
        }
      }
    }
    this.d.store.setCursor("evm", end);
  }

  private context(w: Watch, height: number): DetectContext {
    return {
      explain: { tokens: this.d.chain.tokens, label: labeller(this.d.store, w.chatId), blockSeconds: this.d.chain.cfg.blockSeconds, height, ...(w.owned ? { viewer: w.address } : {}) },
      watch: w,
      height,
      blockSeconds: this.d.chain.cfg.blockSeconds,
      publicUrl: this.d.publicUrl,
      explorer: this.d.chain.cfg.explorer,
    };
  }

  private async deliver(w: Watch, alerts: Awaited<ReturnType<TxDetector["detect"]>>): Promise<void> {
    const chat = this.d.store.chat(w.chatId);
    if (!chat) return;
    for (const a of alerts) {
      const outcome = await this.d.deliverer.deliver(chat, a, w);
      if (outcome === "sent") this.status.alertsSent++;
    }
  }

  /** Follow-ups that happen later: window expiry warnings and unstaking completion. */
  private schedule(tx: TxRecord, hits: string[]): void {
    const warnBlocks = Math.round(WINDOW_WARN_SECONDS / this.d.chain.cfg.blockSeconds);
    for (const ev of tx.events) {
      if (ev.kind === "window_opened" && hits.includes(ev.address)) {
        const length = ev.expiryHeight - tx.height;
        // Only windows long enough for a warning to be useful (over twice the warning time).
        if (length > warnBlocks * 2) this.d.store.schedule({ kind: "window_expiry", key: `winexp:${ev.address}:${ev.expiryHeight}`, address: ev.address, dueHeight: ev.expiryHeight - warnBlocks, data: { expiryHeight: ev.expiryHeight } });
      }
      if (ev.kind === "window_closed" && hits.includes(ev.address)) this.d.store.cancelSchedules("window_expiry", ev.address);
      if (ev.kind === "unbond" && hits.includes(ev.delegator) && ev.completionTime) {
        const at = Date.parse(ev.completionTime);
        if (Number.isFinite(at)) this.d.store.schedule({ kind: "unbond_done", key: `unbond:${ev.delegator}:${ev.completionTime}`, address: ev.delegator, dueAt: at + 60_000, data: { amount: ev.amount.map((c) => `${c.amount}${c.denom}`).join(","), validator: ev.validator } });
      }
    }
  }

  /** Run until stop(): tick, sleep, repeat. Node errors are logged and retried with backoff. */
  async run(pollMs: number): Promise<void> {
    this.running = true;
    let backoff = pollMs;
    await this.withRetry(() => this.init());
    while (this.running) {
      try {
        const n = await this.tick();
        this.status.lastError = undefined;
        backoff = pollMs;
        if (n < 5) await sleep(pollMs);
      } catch (e) {
        this.status.lastError = (e as Error).message;
        this.d.log.warn("watcher tick failed", { error: (e as Error).message });
        backoff = Math.min(60_000, backoff * 2);
        await sleep(backoff);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async withRetry(fn: () => Promise<void>): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        this.status.lastError = (e as Error).message;
        this.d.log.warn("watcher start failed, retrying", { error: (e as Error).message });
        await sleep(Math.min(60_000, 2000 * 2 ** i));
        if (!this.running) return;
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export { evmToQor };
