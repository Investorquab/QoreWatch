import { api, ApiError } from "../api.js";
import { selfSend, walletHelp } from "../qorex.js";
import { $, esc, fragment, notice, setBusy, shell } from "../ui.js";
import { connectStep, telegramButton, txLink, until } from "./common.js";

type LinkStatus = { status: "pending"; memo: string; expiresAt: number } | { status: "linked"; address: string } | { status: "expired" | "invalid" };

const main = shell("Link your wallet");
const code = (location.hash.slice(1).split("&")[0] ?? "").toUpperCase() || fragment().get("code") || "";

async function load(): Promise<LinkStatus> {
  try {
    return await api<LinkStatus>(`/link/${encodeURIComponent(code)}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { status: "invalid" };
    throw e;
  }
}

function done(address: string, hash?: string) {
  main.innerHTML = `
    <p class="eyebrow">Wallet linked</p>
    <h1>You're all set.</h1>
    <p class="lead">QoreWatch now watches this address for you and has sent a confirmation in Telegram.</p>
    <div class="card"><p class="addr">${esc(address)}</p>${hash ? `<p class="small muted">Link transaction ${txLink(hash)}</p>` : ""}<div class="row">${telegramButton()}</div></div>`;
}

async function start() {
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    main.innerHTML = `<h1>This link is not valid</h1><p class="lead">Open the link the bot sent you, or send /link in Telegram to get a new one.</p>${telegramButton("Open QoreWatch")}`;
    return;
  }
  const s = await load();
  if (s.status === "linked") return done(s.address);
  if (s.status !== "pending") {
    main.innerHTML = `<h1>This link has ${s.status === "expired" ? "expired" : "already been used or is not valid"}</h1><p class="lead">Codes work once, for 15 minutes. Send /link in Telegram for a new one.</p>${telegramButton("Get a new link")}`;
    return;
  }
  main.innerHTML = `
    <p class="eyebrow">Link your wallet</p>
    <h1>Prove this address is yours, without a password.</h1>
    <p class="lead">You approve one tiny transaction to yourself in QoreX. Its note carries your code, and QoreX signs it with your post-quantum key. QoreWatch never sees a key.</p>
    <div class="card">
      <ol class="steps">
        <li class="active" id="s1"><div id="connect"></div></li>
        <li id="s2"><h3>Send the link transaction</h3><p>1 uqor from you to you (plus the network fee, about 0.06 QOR), with this note:</p><p><span class="memo">${esc(s.memo)}</span></p><button class="btn btn-primary" id="send" disabled>Approve in QoreX</button><div class="notice hidden" id="send-msg"></div></li>
        <li id="s3"><h3>QoreWatch confirms</h3><p>It sees the transaction on chain within seconds and messages you in Telegram.</p><div class="notice hidden" id="wait-msg"></div></li>
      </ol>
    </div>
    <p class="small muted" style="margin-top:16px">Code ${esc(code)} · works once, until ${esc(new Date(s.expiresAt).toLocaleTimeString())}</p>`;
  const send = $("#send") as HTMLButtonElement;
  connectStep($("#connect"), {
    onReady: (account) => {
      $("#s2").classList.add("active");
      send.disabled = false;
      send.onclick = async () => {
        setBusy(send, true, "Waiting for QoreX…");
        try {
          // Tie the code to this address first: a copy of the code is then useless to anyone else.
          await api(`/link/${code}/claim`, { address: account.qor });
          const hash = await selfSend(account, s.memo);
          $("#s2").classList.replace("active", "done");
          $("#s3").classList.add("active");
          send.classList.add("hidden");
          notice($("#send-msg"), "ok", `Sent. Transaction ${hash ? txLink(hash) : "submitted"}.`);
          notice($("#wait-msg"), "", `<span class="row"><span class="spinner"></span> Waiting for QoreWatch to see it on chain…</span>`);
          const ok = await until(async () => (await load()).status === "linked", 2500, 3 * 60_000);
          if (ok) done(account.qor, hash);
          else notice($("#wait-msg"), "warn", "QoreWatch has not confirmed yet. The chain may be slow; check Telegram in a minute.");
        } catch (e) {
          notice($("#send-msg"), "bad", e instanceof ApiError ? esc(e.message) : walletHelp(e));
          setBusy(send, false);
        }
      };
    },
  });
}

start().catch((e) => {
  main.innerHTML = `<h1>Something went wrong</h1><p class="lead">${esc((e as Error).message)}</p>`;
});
