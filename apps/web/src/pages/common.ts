import { connect, walletHelp, type Account } from "../qorex.js";
import { $, esc, notice, setBusy, short } from "../ui.js";

/**
 * The "Connect QoreX" step used by every page that signs something. `expect` restricts
 * which account may continue (the one the fix is for); `onReady` runs once connected.
 */
export function connectStep(root: HTMLElement, opts: { expect?: (a: Account) => string | undefined; onReady: (a: Account) => void }): void {
  root.innerHTML = `
    <h3>Connect QoreX</h3>
    <p>QoreX asks you to approve this site. It shares your address, never a key.</p>
    <button class="btn btn-primary" id="connect">Connect QoreX</button>
    <div class="notice hidden" id="connect-msg"></div>`;
  const btn = $("#connect", root) as HTMLButtonElement;
  const msg = $("#connect-msg", root);
  btn.addEventListener("click", async () => {
    setBusy(btn, true, "Waiting for QoreX…");
    try {
      const a = await connect();
      const problem = opts.expect?.(a);
      if (problem) {
        notice(msg, "warn", problem);
        setBusy(btn, false);
        return;
      }
      root.closest("li")?.classList.replace("active", "done");
      root.innerHTML = `<h3>Connected</h3><p class="addr">${esc(a.qor)}</p><p class="small muted">${a.kind === "ethereum" ? "Ethereum account (coin 60)" : "Main account (coin 118)"}</p>`;
      opts.onReady(a);
    } catch (e) {
      notice(msg, "bad", walletHelp(e));
      setBusy(btn, false);
    }
  });
}

/** Poll fn every `ms` until it returns true or `limitMs` passes. */
export async function until(fn: () => Promise<boolean>, ms = 2500, limitMs = 5 * 60_000): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

export const telegramButton = (label = "Back to Telegram") => `<a class="btn btn-primary" href="https://t.me/qorewatchbot" rel="noopener">${esc(label)}</a>`;
export const txLink = (hash: string) => `<a href="/tx/${encodeURIComponent(hash)}">${esc(short(hash, 10, 6))}</a>`;
