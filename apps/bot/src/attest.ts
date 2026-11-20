import { createHash } from "node:crypto";
import { evmToQor, esc, shortAddress, type HealthReport } from "@qorewatch/core";
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { Chain } from "./chain.js";
import type { Store } from "./db/store.js";
import type { Messenger } from "./telegram/messenger.js";
import type { Logger } from "./log.js";
import { pages } from "./links.js";

export const ATTEST_ABI = parseAbi([
  "function attest(uint16 score, bytes32 reportHash, bytes8 code)",
  "event Attested(address indexed account, uint16 score, bytes32 reportHash, bytes8 code, uint64 time)",
  "function attestationOf(address account) view returns (bool exists, (uint64 time, uint64 blockNumber, uint16 score, bytes32 reportHash) a, uint256 total)",
]);

/**
 * The canonical form of a report that gets hashed: address, status, score and the ids
 * of the findings, in order, plus the UTC date. Anyone can rebuild it from a fresh check.
 */
export function canonicalReport(r: Pick<HealthReport, "address" | "status" | "score" | "findings" | "checkedAt">): string {
  return JSON.stringify({ v: 1, address: r.address, status: r.status, score: r.score, findings: r.findings.map((f) => f.id), date: r.checkedAt.slice(0, 10) });
}

export const reportHash = (canonical: string): Hex => `0x${createHash("sha3-256").update(canonical).digest("hex")}` as Hex;

/** bytes8 from an 8-character code (ASCII). */
export const codeBytes = (code: string): Hex => `0x${Buffer.from(code.padEnd(8, "\0").slice(0, 8), "latin1").toString("hex")}` as Hex;
export const codeFromBytes = (b: Hex): string => Buffer.from(b.slice(2), "hex").toString("latin1").replace(/\0+$/, "");

/** Remember the report QoreWatch issued for a code, to compare with what lands on chain. */
export function rememberIssued(store: Store, code: string, address: string, score: number, hash: Hex): void {
  store.set(`attest:${code}`, JSON.stringify({ address, score, hash }));
}

/**
 * Watches the attest contract's Attested events. When one carries a live attest code,
 * the chat that asked for it gets a confirmation saying whether the score and report
 * hash match the report QoreWatch issued.
 */
export function attestHook(d: { store: Store; chain: Chain; messenger: Messenger; log: Logger; contract: string; publicUrl: string }) {
  return {
    async scan(height?: number): Promise<number> {
      if (height === undefined) return 0;
      const from = (d.store.cursor("attest") ?? height - 1) + 1;
      if (from > height) return 0;
      const to = Math.min(height, from + d.chain.cfg.maxLogRange - 1);
      const logs = await d.chain.evm.client.getLogs({ address: d.contract as Hex, fromBlock: BigInt(from), toBlock: BigInt(to) });
      let n = 0;
      for (const l of logs) {
        let ev;
        try {
          ev = decodeEventLog({ abi: ATTEST_ABI, data: l.data, topics: l.topics });
        } catch {
          continue;
        }
        if (ev.eventName !== "Attested") continue;
        n++;
        await this.handle({ account: ev.args.account.toLowerCase(), score: ev.args.score, reportHash: ev.args.reportHash, code: codeFromBytes(ev.args.code), txHash: l.transactionHash!, block: Number(l.blockNumber) });
      }
      d.store.setCursor("attest", to);
      return n;
    },

    async handle(a: { account: string; score: number; reportHash: Hex; code: string; txHash: string; block: number }): Promise<boolean> {
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(a.code)) return false;
      const qor = evmToQor(a.account);
      // The code is public once its transaction is pending (calldata) and is shown in the chat. It only
      // counts for an account this chat linked, so a copy used first from another account changes nothing.
      const info = d.store.codeInfo(a.code);
      if (!info || !d.store.watch(info.chatId, qor)?.owned) return false;
      const used = d.store.consumeCode(a.code, "attest", qor);
      if (!used) return false;
      const issued = d.store.get(`attest:${a.code}`);
      const exp = issued ? (JSON.parse(issued) as { address: string; score: number; hash: string }) : undefined;
      const matches = !!exp && exp.address === qor && exp.score === a.score && exp.hash.toLowerCase() === a.reportHash.toLowerCase();
      await d.messenger.send(
        used.chatId,
        [
          "📜 <b>Attestation recorded on QoreChain</b>",
          `<code>${esc(shortAddress(qor, 10, 6))}</code> attested a score of <b>${a.score}</b>/100 at block ${a.block.toLocaleString("en-US")}.`,
          matches ? "✅ It matches the report QoreWatch gave you." : "⚠️ It does not match the report QoreWatch issued for this code. The record stands, but QoreWatch does not vouch for its score.",
        ].join("\n"),
        [[{ text: "🔎 Transaction", url: `${d.chain.cfg.explorer}/tx/${a.txHash}` }, { text: "🩺 Check now", url: pages(d.publicUrl).check(qor) }]],
      );
      d.log.info("attestation", { matches });
      return true;
    },
  };
}
