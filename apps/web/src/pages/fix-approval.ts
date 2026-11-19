import { api } from "../api.js";
import { approveZero, evmCall, walletHelp } from "../qorex.js";
import { $, esc, notice, setBusy, shell } from "../ui.js";
import { connectStep, telegramButton, until } from "./common.js";

const main = shell("Revoke a token approval");
const p = new URLSearchParams(location.hash.slice(1));
const owner = (p.get("owner") ?? "").toLowerCase();
const token = p.get("token") ?? "";
const spender = p.get("spender") ?? "";
const read = () => api<{ value: string; symbol: string; decimals: number }>(`/allowance?${new URLSearchParams({ owner, token, spender })}`);

async function start() {
  const a = await read();
  if (BigInt(a.value) === 0n) {
    main.innerHTML = `<p class="eyebrow">Nothing to revoke</p><h1>That approval is already gone.</h1>${telegramButton()}`;
    return;
  }
  const unlimited = BigInt(a.value) >= 2n ** 255n;
  main.innerHTML = `
    <p class="eyebrow">Token approval</p>
    <h1>Remove ${esc(a.symbol)} spending rights.</h1>
    <p class="lead"><code>${esc(spender)}</code> can move ${unlimited ? `<b>all</b> of your ${esc(a.symbol)}` : `some of your ${esc(a.symbol)}`} without asking. Setting the approval to zero takes that away.</p>
    <div class="card"><ol class="steps">
      <li class="active"><div id="connect"></div></li>
      <li id="s2"><h3>Set the approval to 0</h3><p>An EVM transaction to the ${esc(a.symbol)} contract. QoreX opens a one-transaction ML-DSA-87 window for it.</p><button class="btn btn-danger" id="go" disabled>Revoke in QoreX</button><div class="notice hidden" id="msg"></div></li>
    </ol></div>`;
  connectStep($("#connect"), {
    expect: (acc) => (acc.evm === owner ? undefined : `QoreX is on <code>${esc(acc.evm)}</code>. Switch to <code>${esc(owner)}</code>, the account that gave the approval.`),
    onReady: (acc) => {
      $("#s2").classList.add("active");
      const btn = $("#go") as HTMLButtonElement;
      btn.disabled = false;
      btn.onclick = async () => {
        setBusy(btn, true, "Waiting for QoreX…");
        try {
          await evmCall(acc, token, approveZero(spender));
          notice($("#msg"), "", `<span class="row"><span class="spinner"></span> Sent. Confirming…</span>`);
          const gone = await until(async () => BigInt((await read()).value) === 0n, 2500, 2 * 60_000);
          notice($("#msg"), gone ? "ok" : "warn", gone ? "✅ <b>Approval removed.</b>" : "Sent, not confirmed yet. Check again in a minute.");
          btn.classList.add("hidden");
        } catch (e) {
          notice($("#msg"), "bad", walletHelp(e));
          setBusy(btn, false);
        }
      };
    },
  });
}
start().catch((e) => (main.innerHTML = `<h1>Could not read the approval</h1><p class="lead">${esc((e as Error).message)}</p>`));
