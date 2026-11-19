import { api } from "../api.js";
import { selfSend, walletHelp } from "../qorex.js";
import { $, esc, notice, setBusy, shell } from "../ui.js";
import { connectStep, telegramButton, txLink, until } from "./common.js";

const main = shell("Register your post-quantum key");
const address = decodeURIComponent(location.hash.slice(1));
const read = () => api<{ pqc: { found: boolean }; auth: { exists: boolean; classicalKeyExposed: boolean } }>(`/account/${encodeURIComponent(address)}`);

async function start() {
  const a = await read();
  if (a.pqc.found) {
    main.innerHTML = `<p class="eyebrow">Post-quantum key</p><h1>This account already has one.</h1><p class="lead">An ML-DSA-87 key is registered, so every transaction needs it.</p>${telegramButton()}`;
    return;
  }
  main.innerHTML = `
    <p class="eyebrow">Q-Day readiness</p>
    <h1>Register your ML-DSA-87 key, before someone else does.</h1>
    <p class="lead">${a.auth.classicalKeyExposed ? "This account has signed before, so its classical public key is on chain. " : ""}Until it has a post-quantum key, whoever first derives the classical key could register their own and take the account over. QoreX registers your key with the account's next transaction.</p>
    <div class="card"><ol class="steps">
      <li class="active"><div id="connect"></div></li>
      <li id="s2"><h3>Send one tiny transaction</h3><p>1 uqor to yourself. QoreX adds the one-time key registration and shows its fee before you approve.</p><button class="btn btn-primary" id="go" disabled>Register in QoreX</button><div class="notice hidden" id="msg"></div></li>
    </ol></div>
    <p class="small muted" style="margin-top:14px">Prefer to do it in the wallet? Send anything from this account in QoreX: the first send registers the key.</p>`;
  connectStep($("#connect"), {
    expect: (acc) => (acc.qor === address ? undefined : `QoreX is on <code>${esc(acc.qor)}</code>. Switch to <code>${esc(address)}</code>.`),
    onReady: (acc) => {
      $("#s2").classList.add("active");
      const btn = $("#go") as HTMLButtonElement;
      btn.disabled = false;
      btn.onclick = async () => {
        setBusy(btn, true, "Waiting for QoreX…");
        try {
          const hash = await selfSend(acc, "QoreWatch: register my post-quantum key");
          notice($("#msg"), "", `<span class="row"><span class="spinner"></span> Sent${hash ? ` (${txLink(hash)})` : ""}. Confirming…</span>`);
          const ok = await until(async () => (await read()).pqc.found, 3000, 2 * 60_000);
          notice($("#msg"), ok ? "ok" : "warn", ok ? "✅ <b>Registered.</b> The account is now protected by ML-DSA-87." : "Sent, but the key is not showing yet. Check again in a minute.");
          btn.classList.add("hidden");
        } catch (e) {
          notice($("#msg"), "bad", walletHelp(e));
          setBusy(btn, false);
        }
      };
    },
  });
}
start().catch((e) => (main.innerHTML = `<h1>Could not read the account</h1><p class="lead">${esc((e as Error).message)}</p>`));
