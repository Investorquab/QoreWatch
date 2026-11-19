import { duration, esc, fmtDate, parseCoins, qor, shortAddress } from "@qorewatch/core";
import type { Chain } from "../chain.js";
import type { Store } from "../db/store.js";
import type { Deliverer } from "../alerts/deliver.js";
import type { Messenger } from "../telegram/messenger.js";
import type { Logger } from "../log.js";
import type { Alert } from "../alerts/types.js";
import { localDate, localMinute } from "../alerts/time.js";
import { pages } from "../links.js";
import { buildDigest } from "../features/digest.js";
import { change, fmtPrice, poolPrices } from "../features/pools.js";
import { proposalTitle } from "../features/governance.js";

export interface JobDeps {
  store: Store;
  chain: Chain;
  deliverer: Deliverer;
  messenger: Messenger;
  log: Logger;
  publicUrl: string;
  /** The block the watcher has reached. */
  height: () => number | undefined;
  now?: () => Date;
}

/** Notified-bit flags for proposals. */
const NEW = 1;
const ENDING = 2;
const RESULT = 4;

/**
 * Everything that happens on a clock rather than on a block: follow-up warnings,
 * quiet-hours delivery, daily digests, pool prices, governance and network notices.
 * Each job is independent; one failing never stops the others.
 */
export class Jobs {
  private last: Record<string, number> = {};
  constructor(private readonly d: JobDeps) {}

  private get now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** Run every job that is due. Call about once a minute. */
  async runDue(): Promise<void> {
    const every = async (name: string, ms: number, fn: () => Promise<unknown>) => {
      const t = this.now.getTime();
      if (t - (this.last[name] ?? 0) < ms) return;
      this.last[name] = t;
      try {
        await fn();
      } catch (e) {
        this.d.log.warn("job failed", { job: name, error: (e as Error).message });
      }
    };
    await every("schedules", 30_000, () => this.schedules());
    await every("held", 60_000, () => this.d.deliverer.flushHeld());
    await every("digest", 60_000, () => this.digests());
    await every("pools", 5 * 60_000, () => this.pools());
    await every("governance", 5 * 60_000, () => this.governance());
    await every("upgrade", 10 * 60_000, () => this.upgrade());
    await every("validators", 15 * 60_000, () => this.validators());
    await every("prune", 60 * 60_000, async () => this.d.store.pruneSent(this.now.getTime()));
  }

  /** Alert every chat watching an address. */
  private async toWatchers(address: string, alert: Alert): Promise<void> {
    for (const w of this.d.store.watchersOf(address)) {
      const chat = this.d.store.chat(w.chatId);
      if (chat) await this.d.deliverer.deliver(chat, alert, w);
    }
  }

  /** Alert every chat (governance and network notices). */
  private async toAll(alert: Alert, filter: (c: ReturnType<Store["chats"]>[number]) => boolean = () => true): Promise<number> {
    let n = 0;
    for (const chat of this.d.store.chats()) {
      if (!filter(chat)) continue;
      if ((await this.d.deliverer.deliver(chat, alert)) === "sent") n++;
    }
    return n;
  }

  async schedules(): Promise<void> {
    const h = this.d.height();
    if (h === undefined) return;
    for (const s of this.d.store.dueSchedules(h, this.now.getTime())) {
      this.d.store.completeSchedule(s.id);
      if (s.kind === "window_expiry") {
        const w = await this.d.chain.rest.evmWindow(s.address);
        if (!w.live || w.expiryHeight !== s.data.expiryHeight) continue;
        await this.toWatchers(s.address, {
          key: `winexp:${s.address}:${w.expiryHeight}`,
          category: "security",
          level: "warning",
          address: s.address,
          title: "⏰ <b>Spending window closes in about 30 minutes</b>",
          body: [
            `${w.remainingTxs ?? "?"} transaction${w.remainingTxs === 1 ? "" : "s"} and ${w.remainingValueUqor !== undefined ? qor(w.remainingValueUqor) : "an unknown amount"} can still be spent, for about ${duration(w.remainingBlocks ?? 0, this.d.chain.cfg.blockSeconds)}.`,
            "Finished? Close it now in QoreX instead of waiting.",
          ],
          buttons: [[{ text: "🛠 Close the window", url: pages(this.d.publicUrl).fixWindow(s.address) }]],
        });
      }
      if (s.kind === "unbond_done") {
        const coins = parseCoins(String(s.data.amount ?? ""));
        const amount = (await Promise.all(coins.map((c) => this.d.chain.tokens.format(c.amount, c.denom)))).join(" + ");
        await this.toWatchers(s.address, {
          key: `unbonded:${s.key}`,
          category: "staking",
          level: "info",
          address: s.address,
          title: "✅ <b>Unstaking finished</b>",
          body: [`${esc(amount || "Your stake")} is back in the account and can be spent again.`],
        });
      }
    }
  }

  async digests(): Promise<void> {
    for (const chat of this.d.store.chats()) {
      if (chat.digestMinute === null || chat.paused) continue;
      const today = localDate(chat.tz, this.now);
      if (chat.lastDigest === today) continue;
      const m = localMinute(chat.tz, this.now);
      if (m < chat.digestMinute || m > chat.digestMinute + 120) continue;
      this.d.store.updateChat(chat.id, { lastDigest: today });
      const v = await buildDigest(chat.id, this.d.store, this.d.chain);
      await this.d.messenger.send(chat.id, v.html, v.buttons);
    }
  }

  async pools(): Promise<void> {
    const watches = this.d.store.poolWatches();
    if (!watches.length) return;
    const prices = new Map((await poolPrices(await this.d.chain.rest.pools(), this.d.chain.tokens)).map((p) => [p.id, p]));
    for (const w of watches) {
      const p = prices.get(w.poolId);
      if (!p || !w.basePrice) continue;
      const pct = change(w.basePrice, p.price);
      if (Math.abs(pct) < w.pct) continue;
      const chat = this.d.store.chat(w.chatId);
      if (!chat) continue;
      this.d.store.setPoolWatch(w.chatId, w.poolId, w.pct, p.price, this.now.getTime());
      await this.d.deliverer.deliver(chat, {
        key: `pool:${w.poolId}:${w.chatId}:${this.now.getTime()}`,
        category: "pools",
        level: "info",
        title: `${pct > 0 ? "📈" : "📉"} <b>Pool #${esc(w.poolId)} ${esc(p.name)} moved ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</b>`,
        body: [`Now ${esc(p.priceText)}, from ${fmtPrice(w.basePrice)}. I'll tell you again after the next ${w.pct}% move.`],
      });
    }
  }

  async governance(): Promise<void> {
    const recent = await this.d.chain.rest.proposals(undefined, 20);
    const seeded = this.d.store.get("gov_seeded") === "1";
    for (const p of recent) {
      const known = this.d.store.proposal(p.id);
      if (!seeded) {
        // First run: remember what exists without announcing history.
        this.d.store.upsertProposal(p.id, p.status, p.votingEndTime ?? null, NEW | ENDING | RESULT);
        continue;
      }
      let notified = known?.notified ?? 0;
      const voting = p.status === "PROPOSAL_STATUS_VOTING_PERIOD";
      if (voting && !(notified & NEW)) {
        await this.toAll(
          {
            key: `gov:new:${p.id}`,
            category: "governance",
            level: "info",
            title: `🗳 <b>New governance proposal #${esc(p.id)}</b>`,
            body: [proposalTitle(p), ...(p.summary ? [esc(p.summary.slice(0, 300))] : []), ...(p.votingEndTime ? [`Voting ends ${fmtDate(p.votingEndTime)}.`] : [])],
          },
          (c) => !c.muted.includes("governance"),
        );
        notified |= NEW;
      }
      const ends = p.votingEndTime ? Date.parse(p.votingEndTime) : NaN;
      if (voting && Number.isFinite(ends) && ends - this.now.getTime() < 2 * 3600_000 && ends > this.now.getTime() && !(notified & ENDING)) {
        await this.toAll({ key: `gov:ending:${p.id}`, category: "governance", level: "info", title: `⏳ <b>Voting on proposal #${esc(p.id)} ends in under 2 hours</b>`, body: [proposalTitle(p)] }, (c) => !c.muted.includes("governance"));
        notified |= ENDING;
      }
      const final = ["PROPOSAL_STATUS_PASSED", "PROPOSAL_STATUS_REJECTED", "PROPOSAL_STATUS_FAILED"].includes(p.status);
      if (final && known && known.status === "PROPOSAL_STATUS_VOTING_PERIOD" && !(notified & RESULT)) {
        const word = p.status === "PROPOSAL_STATUS_PASSED" ? "passed ✅" : p.status === "PROPOSAL_STATUS_REJECTED" ? "was rejected ❌" : "failed ⚠️";
        await this.toAll({ key: `gov:result:${p.id}`, category: "governance", level: "info", title: `🗳 <b>Proposal #${esc(p.id)} ${word}</b>`, body: [proposalTitle(p)] }, (c) => !c.muted.includes("governance"));
        notified |= RESULT;
      }
      this.d.store.upsertProposal(p.id, p.status, p.votingEndTime ?? null, notified);
    }
    if (!seeded) this.d.store.set("gov_seeded", "1");
  }

  async upgrade(): Promise<void> {
    const plan = await this.d.chain.rest.upgradePlan();
    const h = this.d.height();
    if (!plan || h === undefined || plan.height <= h) return;
    const left = plan.height - h;
    const when = `at block ${plan.height.toLocaleString("en-US")}, in about ${duration(left, this.d.chain.cfg.blockSeconds)}`;
    if (this.d.store.get("upgrade_announced") !== plan.name) {
      await this.toAll(
        { key: `upgrade:${plan.name}`, category: "network", level: "info", title: `📡 <b>QoreChain ${esc(this.d.chain.cfg.name)} upgrades to ${esc(plan.name)}</b>`, body: [`Scheduled ${when}. The chain pauses briefly while validators switch; transactions wait until it resumes. QoreWatch catches up on its own.`] },
        (c) => c.networkAlerts,
      );
      this.d.store.set("upgrade_announced", plan.name);
    }
    if (left < Math.round(3600 / this.d.chain.cfg.blockSeconds) && this.d.store.get("upgrade_soon") !== plan.name) {
      await this.toAll({ key: `upgrade-soon:${plan.name}`, category: "network", level: "info", title: `📡 <b>Upgrade ${esc(plan.name)} in under an hour</b>`, body: [`It happens ${when}. Avoid sending anything time-sensitive around then.`] }, (c) => c.networkAlerts);
      this.d.store.set("upgrade_soon", plan.name);
    }
  }

  /** Watched accounts whose validator was jailed: their stake earns nothing and may be slashed. */
  async validators(): Promise<void> {
    const addresses = [...this.d.store.watchedAddresses()].slice(0, 200);
    const status = new Map<string, Awaited<ReturnType<Chain["rest"]["validator"]>>>();
    for (const a of addresses) {
      const dels = await this.d.chain.rest.delegations(a).catch(() => []);
      for (const del of dels) {
        if (!status.has(del.validator)) status.set(del.validator, await this.d.chain.rest.validator(del.validator).catch(() => undefined));
        const v = status.get(del.validator);
        if (!v?.jailed) continue;
        await this.toWatchers(a, {
          key: `jailed:${v.operator}:${a}:${localDate("UTC", this.now)}`,
          category: "staking",
          level: "warning",
          address: a,
          title: `⚠️ <b>Your validator ${esc(v.moniker || shortAddress(v.operator, 14, 4))} is jailed</b>`,
          body: [`${qor(del.amount.amount)} is staked with it. A jailed validator earns no rewards and may be slashed. Consider moving the stake to another validator.`],
        });
      }
    }
  }
}

