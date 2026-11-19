import { api } from "../api.js";
import { esc, shell, short } from "../ui.js";

interface Tx {
  hash: string;
  evmHash: string | null;
  height: number;
  time: string;
  failed: boolean;
  failReason: string | null;
  signer: string | null;
  hybridSigned: boolean;
  classicalOnly: boolean;
  memo: string;
  title: string;
  lines: string[];
  flags: string[];
  messages: string[];
  explorer: string;
}

const main = shell("Transaction");
const hash = decodeURIComponent(location.pathname.split("/").pop() ?? "");

async function start() {
  main.innerHTML = `<p class="eyebrow">Transaction</p><h1>Reading QoreChain…</h1>`;
  const t = await api<Tx>(`/tx/${encodeURIComponent(hash)}`);
  const sig = t.classicalOnly ? `<span class="pill bad">Classical signature only</span>` : t.hybridSigned ? `<span class="pill ok">Hybrid ML-DSA-87 signature</span>` : `<span class="pill muted">EVM transaction</span>`;
  main.innerHTML = `
    <p class="eyebrow">Transaction · block ${t.height.toLocaleString("en-US")}</p>
    <h1>${esc(t.title)}</h1>
    <div class="row" style="margin-bottom:22px">${t.failed ? `<span class="pill bad">Failed</span>` : `<span class="pill ok">Succeeded</span>`} ${sig}</div>
    <div class="card"><h3 style="margin-top:0">What happened</h3><ul class="lines">${t.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      ${t.flags.length ? `<div class="notice warn">${t.flags.map(esc).join("<br>")}</div>` : ""}
      ${t.failReason ? `<div class="notice bad">${esc(t.failReason)}</div>` : ""}</div>
    <div class="card"><dl class="kv">
      <dt>Time</dt><dd>${esc(t.time.replace("T", " ").slice(0, 19))} UTC</dd>
      <dt>Signed by</dt><dd class="mono">${esc(t.signer ?? "unknown")}</dd>
      <dt>Hash</dt><dd class="mono">${esc(t.hash)}</dd>
      ${t.evmHash ? `<dt>EVM hash</dt><dd class="mono">${esc(t.evmHash)}</dd>` : ""}
      ${t.memo ? `<dt>Note</dt><dd>${esc(t.memo)}</dd>` : ""}
      <dt>Messages</dt><dd class="mono small">${t.messages.map(esc).join("<br>")}</dd>
    </dl>
    <div class="row" style="margin-top:18px"><a class="btn btn-ghost" href="${esc(t.explorer)}" rel="noopener">Open in the explorer</a><span class="small muted">The explorer opens on Mainnet: pick Testnet at the top.</span></div></div>`;
}
start().catch((e) => (main.innerHTML = `<h1>Transaction not found</h1><p class="lead">${esc((e as Error).message)}</p><p class="addr">${esc(short(hash, 16, 8))}</p>`));
