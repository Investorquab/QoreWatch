import { api } from "../api.js";
import { $, duration, esc, notice, qor, shell } from "../ui.js";
import { telegramButton, until } from "./common.js";

interface Win { found: boolean; live: boolean; remainingTxs?: number; remainingValueUqor?: string; remainingBlocks?: number; allowedTargets: string[]; blockSeconds: number }

const main = shell("Close your spending window");
const address = decodeURIComponent(location.hash.slice(1));

async function start() {
  const w = await api<Win>(`/window/${encodeURIComponent(address)}`);
  if (!w.live) {
    main.innerHTML = `<p class="eyebrow">EVM spending window</p><h1>No window is open.</h1><p class="lead">The classical key alone cannot spend from <code>${esc(address.slice(0, 14))}…</code> on the EVM lane right now.</p>${telegramButton()}`;
    return;
  }
  main.innerHTML = `
    <p class="eyebrow">EVM spending window</p>
    <h1>Close the window in QoreX.</h1>
    <p class="lead">While it is open, anyone holding this account's classical key can spend inside it. QoreX only lets you close it from the wallet itself, never from a website, which is the right call for a security control. It takes about ten seconds.</p>
    <div class="card"><dl class="kv">
      <dt>Account</dt><dd class="mono">${esc(address)}</dd>
      <dt>Still allowed</dt><dd><b>${w.remainingTxs ?? "?"}</b> transaction${w.remainingTxs === 1 ? "" : "s"}, up to <b>${w.remainingValueUqor ? qor(w.remainingValueUqor) : "?"}</b></dd>
      <dt>Recipients</dt><dd>${w.allowedTargets.length ? w.allowedTargets.map((t) => `<code>${esc(t)}</code>`).join("<br>") : `<span class="pill warn">Any address</span>`}</dd>
      <dt>Closes by itself</dt><dd>in about ${duration(w.remainingBlocks ?? 0, w.blockSeconds)}</dd>
    </dl></div>
    <div class="card"><ol class="steps">
      <li class="active"><h3>Open QoreX</h3><p>Click the QoreX icon in your browser and unlock it. Make sure the account above is the active one.</p></li>
      <li><h3>Tap your EVM window</h3><p>On the home screen, tap the line that says <b>“Tap to check or open your EVM window”</b>.</p></li>
      <li><h3>Close the window</h3><p>Tap <b>Close the window</b> and approve. QoreX signs it with your ML-DSA-87 key.</p></li>
    </ol><div class="notice" id="watch"><span class="row"><span class="spinner"></span> Watching the chain: this page updates the moment the window closes.</span></div></div>`;
  const closed = await until(async () => !(await api<Win>(`/window/${encodeURIComponent(address)}`)).live, 4000, 20 * 60_000);
  if (closed) {
    notice($("#watch"), "ok", "✅ <b>Window closed.</b> The classical key can no longer spend from this account on the EVM lane.");
    $("#watch").insertAdjacentHTML("afterend", `<div class="row" style="margin-top:14px">${telegramButton()}</div>`);
  }
}
start().catch((e) => (main.innerHTML = `<h1>Could not read the window</h1><p class="lead">${esc((e as Error).message)}</p>`));
