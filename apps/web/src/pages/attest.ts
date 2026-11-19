import { api, ApiError } from "../api.js";
import { attestData, evmCall, walletHelp } from "../qorex.js";
import { $, esc, notice, setBusy, shell } from "../ui.js";
import { connectStep, telegramButton, txLink, until } from "./common.js";

type Status = { status: "pending"; accounts: string[]; expiresAt: number } | { status: "attested"; address: string } | { status: "expired" | "invalid" };
type Report = { account: string; evmAccount: string; score: number; status: string; reportHash: `0x${string}`; code: `0x${string}`; contract: string };

const main = shell("Attest your account check");
const code = location.hash.slice(1).toUpperCase();
const load = () => api<Status>(`/attest/${encodeURIComponent(code)}`).catch((e) => (e instanceof ApiError ? ({ status: "invalid" } as Status) : Promise.reject(e)));

async function start() {
  const s = await load();
  if (s.status !== "pending") {
    main.innerHTML = s.status === "attested" ? `<h1>Already attested</h1><p class="lead">This check was recorded on chain. Telegram has the details.</p>${telegramButton()}` : `<h1>This attest link is no longer valid</h1><p class="lead">Send /attest in Telegram for a new one.</p>${telegramButton()}`;
    return;
  }
  main.innerHTML = `
    <p class="eyebrow">On-chain attestation</p>
    <h1>Record that you checked your account.</h1>
    <p class="lead">QoreWatch checks your account now and gives you its score and a fingerprint of the report. You sign them into QoreChain from your own account, so anyone can verify later that you did.</p>
    <div class="card"><ol class="steps">
      <li class="active" id="s1"><div id="connect"></div></li>
      <li id="s2"><h3>Your check</h3><p id="report">Connect first.</p></li>
      <li id="s3"><h3>Sign it into QoreChain</h3><p>An EVM transaction from your account to the QoreWatch attest contract. QoreX opens a one-transaction ML-DSA-87 window for it.</p><button class="btn btn-primary" id="sign" disabled>Sign in QoreX</button><div class="notice hidden" id="msg"></div></li>
    </ol></div>`;
  connectStep($("#connect"), {
    expect: (a) => (s.accounts.includes(a.qor) ? undefined : `QoreX is on <code>${esc(a.qor)}</code>, which is not linked in this chat. Switch QoreX to a linked account${s.accounts.length ? ` (${s.accounts.map((x) => `<code>${esc(x.slice(0, 12))}…</code>`).join(", ")})` : ""}, or link it first with /link.`),
    onReady: async (account) => {
      $("#s2").classList.add("active");
      let r: Report;
      try {
        r = await api<Report>(`/attest/${encodeURIComponent(code)}/report?account=${encodeURIComponent(account.qor)}`);
      } catch (e) {
        $("#report").innerHTML = esc((e as Error).message);
        return;
      }
      $("#report").innerHTML = `Score <b>${r.score}</b>/100 (${esc(r.status.replace("_", " "))}). Report fingerprint <code>${esc(r.reportHash.slice(0, 18))}…</code>`;
      $("#s2").classList.replace("active", "done");
      $("#s3").classList.add("active");
      const btn = $("#sign") as HTMLButtonElement;
      btn.disabled = false;
      btn.onclick = async () => {
        setBusy(btn, true, "Waiting for QoreX…");
        try {
          const hash = await evmCall(account, r.contract, attestData(r.score, r.reportHash, r.code));
          notice($("#msg"), "", `<span class="row"><span class="spinner"></span> Sent (${esc(hash.slice(0, 12))}…). Waiting for QoreWatch to see it…</span>`);
          const ok = await until(async () => (await load()).status === "attested", 3000, 3 * 60_000);
          main.innerHTML = ok
            ? `<p class="eyebrow">Attested</p><h1>Recorded on QoreChain.</h1><p class="lead">Your score of ${r.score}/100 is on chain, signed by your account. QoreWatch confirmed it in Telegram.</p>${telegramButton()}`
            : `<h1>Sent, not confirmed yet</h1><p class="lead">The transaction is on its way (${txLink(hash)}). Telegram will confirm when it lands.</p>${telegramButton()}`;
        } catch (e) {
          notice($("#msg"), "bad", walletHelp(e));
          setBusy(btn, false);
        }
      };
    },
  });
}
start().catch((e) => (main.innerHTML = `<h1>Something went wrong</h1><p class="lead">${esc((e as Error).message)}</p>`));
