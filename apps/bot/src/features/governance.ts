import { esc, fmtDate, type Proposal } from "@qorewatch/core";
import type { View } from "../telegram/views.js";

const STATUS: Record<string, string> = {
  PROPOSAL_STATUS_VOTING_PERIOD: "🗳 voting",
  PROPOSAL_STATUS_DEPOSIT_PERIOD: "💰 waiting for deposit",
  PROPOSAL_STATUS_PASSED: "✅ passed",
  PROPOSAL_STATUS_REJECTED: "❌ rejected",
  PROPOSAL_STATUS_FAILED: "⚠️ failed",
};

export const proposalTitle = (p: Proposal) => esc(p.title || p.messages.map((m) => m.split(".").pop()!.replace(/^Msg/, "")).join(", ") || `Proposal ${p.id}`);

export function proposalsView(recent: Proposal[]): View {
  const voting = recent.filter((p) => p.status === "PROPOSAL_STATUS_VOTING_PERIOD");
  const lines = [voting.length ? `🗳 <b>${voting.length} proposal${voting.length === 1 ? "" : "s"} open for voting</b>` : "🗳 <b>No proposals are open for voting.</b>", ""];
  for (const p of recent.slice(0, 6)) {
    lines.push(`<b>#${esc(p.id)}</b> ${proposalTitle(p)}`, `${STATUS[p.status] ?? esc(p.status)}${p.status === "PROPOSAL_STATUS_VOTING_PERIOD" && p.votingEndTime ? `, ends ${fmtDate(p.votingEndTime)}` : ""}`, "");
  }
  lines.push("New proposals and voting deadlines are announced here unless you mute governance in /settings.");
  return { html: lines.join("\n").trim() };
}

export { STATUS as PROPOSAL_STATUS };
