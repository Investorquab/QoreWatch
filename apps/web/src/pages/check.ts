import { api } from "../api.js";
import { BOT, esc, shell } from "../ui.js";

interface Finding {
  id: string;
  severity: "critical" | "warning" | "info" | "good";
  title: string;
  detail: string;
  fix?: { kind: string; grantee?: string; msgTypeUrl?: string };
}
interface Report {
  address: string;
  status: "ready" | "attention" | "at_risk" | "unused";
  score: number;
  findings: Finding[];
  handle: string | null;
  checkedAt: string;
}
const LABEL = { ready: "Quantum-ready", attention: "Needs attention", at_risk: "At risk", unused: "Not used yet" } as const;
const PILL = { ready: "ok", attention: "warn", at_risk: "bad", unused: "muted" } as const;
const COLOR = { ready: "#34d3b4", attention: "#ffb547", at_risk: "#ff6b6b", unused: "#8b94a5" } as const;

const main = shell("Account check");
const address = decodeURIComponent(location.pathname.split("/").pop() ?? "");

function fixLink(f: Finding, a: string): string {
  if (!f.fix) return "";
  const p = (path: string, frag: string) => `<a class="btn btn-ghost" href="${path}#${frag}">Fix this</a>`;
  switch (f.fix.kind) {
    case "qorex_register_key":
      return p("/fix/key", a);
    case "qorex_close_window":
      return p("/fix/window", a);
    case "revoke_authz":
      return p("/fix/authz", new URLSearchParams({ granter: a, grantee: f.fix.grantee ?? "", msg: f.fix.msgTypeUrl ?? "" }).toString());
    case "revoke_feegrant":
      return p("/fix/feegrant", new URLSearchParams({ granter: a, grantee: f.fix.grantee ?? "" }).toString());
    default:
      return "";
  }
}

async function start() {
  main.innerHTML = `<p class="eyebrow">Post-quantum account check</p><h1>Checking…</h1>`;
  const r = await api<Report>(`/check/${encodeURIComponent(address)}`);
  const c = 2 * Math.PI * 44;
  const pct = r.status === "unused" ? 0 : r.score / 100;
  main.innerHTML = `
    <p class="eyebrow">Post-quantum account check</p>
    <h1>${r.handle ? `@${esc(r.handle)}` : "Account check"}</h1>
    <p class="addr">${esc(r.address)}</p>
    <div class="card" style="margin-top:18px"><div class="score">
      <svg class="ring" viewBox="0 0 108 108" role="img" aria-label="Score ${r.score} out of 100"><circle cx="54" cy="54" r="44" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/><circle cx="54" cy="54" r="44" fill="none" stroke="${COLOR[r.status]}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 54 54)"/><text x="54" y="62" text-anchor="middle" font-size="30" fill="#e8eef3">${r.status === "unused" ? "–" : r.score}</text></svg>
      <div><span class="pill ${PILL[r.status]}">${LABEL[r.status]}</span><p class="muted small" style="margin:10px 0 0">Checked ${esc(r.checkedAt.replace("T", " ").slice(0, 16))} UTC on QoreChain testnet.</p></div>
    </div></div>
    <div class="card"><ul class="findings">${r.findings.map((f) => `<li class="${f.severity}"><div><b>${esc(f.title)}</b><span>${esc(f.detail)}</span>${f.fix ? `<div class="row" style="margin-top:8px">${fixLink(f, r.address)}</div>` : ""}</div></li>`).join("")}</ul></div>
    <div class="card"><h3 style="margin-top:0">Get alerts for this address</h3><p class="muted">QoreWatch messages you in Telegram when money moves, the post-quantum key changes, a spending window opens or someone gets permission to spend.</p><a class="btn btn-primary" href="https://t.me/${BOT}?start=check_${encodeURIComponent(r.address)}" rel="noopener">Watch it in Telegram</a></div>`;
}
start().catch((e) => (main.innerHTML = `<h1>Could not check this address</h1><p class="lead">${esc((e as Error).message)}</p>`));
