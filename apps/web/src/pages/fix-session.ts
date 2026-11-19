import { api } from "../api.js";
import { esc, shell } from "../ui.js";
import { telegramButton } from "./common.js";

const main = shell("Session keys");
const address = decodeURIComponent(location.hash.slice(1));

async function start() {
  const g = await api<{ smartAccount: { sessionKeysCount: number; authenticatorsCount: number; spendingRulesCount: number } | null }>(`/grants/${encodeURIComponent(address)}`);
  const n = (g.smartAccount?.sessionKeysCount ?? 0) + (g.smartAccount?.authenticatorsCount ?? 0);
  main.innerHTML = `
    <p class="eyebrow">Smart account</p>
    <h1>${n ? `${n} session key${n === 1 ? "" : "s"} can sign for this account.` : "No session keys right now."}</h1>
    <p class="lead">A session key lets an app or an AI agent act for your smart account, within its spending rules${g.smartAccount ? ` (${g.smartAccount.spendingRulesCount} set)` : ""}, until it expires.</p>
    <div class="card"><h3 style="margin-top:0">How to remove one</h3>
      <ol class="lines">
        <li><b>In the app that added it.</b> Apps that create session keys offer a way to revoke them (for example a “stop” or “revoke” button).</li>
        <li><b>Let it expire.</b> Every session key has an end date; QoreWatch told you when it was added.</li>
        <li><b>If you do not recognise it</b>, treat the account as exposed: move your funds to a fresh account.</li>
      </ol>
      <p class="muted small">Why not here? QoreX does not let websites add or remove session keys: it manages them itself, so a malicious site can never quietly install one. That is the safe design, so QoreWatch does not work around it.</p>
    </div>${telegramButton()}`;
}
start().catch((e) => (main.innerHTML = `<h1>Could not read the account</h1><p class="lead">${esc((e as Error).message)}</p>`));
