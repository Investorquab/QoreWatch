import { api } from "../api.js";
import { revokeAuthz, revokeFeegrant, walletHelp, type Account } from "../qorex.js";
import { $, esc, notice, setBusy, shell } from "../ui.js";
import { connectStep, telegramButton, txLink, until } from "./common.js";

interface Grants { grants: { grantee: string; msgTypeUrl?: string; authorization: Record<string, unknown>; expiration?: string }[]; feeAllowances: { grantee: string }[] }

/**
 * One-tap revoke for an authz permission or a fee allowance. QoreX lets websites request
 * both (they are ordinary, displayable messages), so the fix happens right here.
 */
export async function revokePage(kind: "authz" | "feegrant"): Promise<void> {
  const main = shell(kind === "authz" ? "Revoke a permission" : "Stop paying someone's fees");
  const p = new URLSearchParams(location.hash.slice(1));
  const granter = p.get("granter") ?? "";
  const grantee = p.get("grantee") ?? "";
  const msg = p.get("msg") ?? "";
  const exists = async () => {
    const g = await api<Grants>(`/grants/${encodeURIComponent(granter)}`);
    return kind === "authz" ? g.grants.some((x) => x.grantee === grantee && (x.msgTypeUrl ?? String(x.authorization.msg ?? "")) === msg) : g.feeAllowances.some((x) => x.grantee === grantee);
  };
  try {
    if (!(await exists())) {
      main.innerHTML = `<p class="eyebrow">Nothing to revoke</p><h1>${kind === "authz" ? "That permission is already gone." : "That fee allowance is already gone."}</h1><p class="lead">It was revoked or it expired.</p>${telegramButton()}`;
      return;
    }
  } catch (e) {
    main.innerHTML = `<h1>Could not read the account</h1><p class="lead">${esc((e as Error).message)}</p>`;
    return;
  }
  const what = kind === "authz" ? `can do <code>${esc(msg.split(".").pop() ?? msg)}</code> on your behalf` : "can spend your QOR on transaction fees";
  main.innerHTML = `
    <p class="eyebrow">${kind === "authz" ? "Permission (authz)" : "Fee allowance"}</p>
    <h1>${kind === "authz" ? "Take this permission back." : "Stop paying their fees."}</h1>
    <p class="lead"><code>${esc(grantee)}</code> ${what}. Revoking it is one transaction from your account, signed in QoreX.</p>
    <div class="card"><ol class="steps">
      <li class="active"><div id="connect"></div></li>
      <li id="s2"><h3>Revoke</h3><p>QoreX shows exactly what is being revoked before you approve.</p><button class="btn btn-danger" id="go" disabled>Revoke in QoreX</button><div class="notice hidden" id="msg"></div></li>
    </ol></div>`;
  connectStep($("#connect"), {
    expect: (a: Account) => (a.qor === granter ? undefined : `QoreX is on <code>${esc(a.qor)}</code>. Switch QoreX to <code>${esc(granter)}</code>, the account that gave the permission.`),
    onReady: (a) => {
      $("#s2").classList.add("active");
      const btn = $("#go") as HTMLButtonElement;
      btn.disabled = false;
      btn.onclick = async () => {
        setBusy(btn, true, "Waiting for QoreX…");
        try {
          const hash = kind === "authz" ? await revokeAuthz(a, grantee, msg) : await revokeFeegrant(a, grantee);
          notice($("#msg"), "", `<span class="row"><span class="spinner"></span> Sent. Confirming on chain…</span>`);
          const gone = await until(async () => !(await exists()), 2500, 2 * 60_000);
          notice($("#msg"), gone ? "ok" : "warn", gone ? `✅ <b>Revoked.</b> ${hash ? `Transaction ${txLink(hash)}.` : ""}` : "Sent, but not confirmed yet. Check again in a minute.");
          btn.classList.add("hidden");
        } catch (e) {
          notice($("#msg"), "bad", walletHelp(e));
          setBusy(btn, false);
        }
      };
    },
  });
}
