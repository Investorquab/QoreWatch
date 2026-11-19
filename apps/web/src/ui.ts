import "./styles.css";

export const BOT = "qorewatchbot";
export const MARK = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 L56 12 V30 C56 45 46 56 32 61 C18 56 8 45 8 30 V12 Z" fill="none" stroke="#34d3b4" stroke-width="3.6" stroke-linejoin="round"/><path d="M16 32 C21 24 26 21 32 21 C38 21 43 24 48 32 C43 40 38 43 32 43 C26 43 21 40 16 32 Z" fill="none" stroke="#e8eef3" stroke-width="3.2"/><circle cx="32" cy="32" r="5.5" fill="#34d3b4"/></svg>`;

/** Escape text for HTML. Every value from the chain or the URL goes through this. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Page shell: header, main, footer. Returns the main element. */
export function shell(title: string): HTMLElement {
  document.title = `${title} · QoreWatch`;
  document.body.innerHTML = `
    <header class="top">
      <a class="brand" href="/">${MARK}<span>QoreWatch</span></a>
      <a class="net" href="https://t.me/${BOT}" rel="noopener">Open in Telegram</a>
    </header>
    <main class="page" id="main"></main>
    <footer class="foot">QoreWatch runs on QoreChain testnet. It never asks for a seed phrase or a private key.</footer>`;
  return document.getElementById("main")!;
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el as HTMLElement;
}

export function short(a: string, head = 10, tail = 6): string {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

export function setBusy(btn: HTMLButtonElement, busy: boolean, label?: string): void {
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(label ?? "Working…")}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export function notice(el: HTMLElement, kind: "ok" | "warn" | "bad" | "", html: string): void {
  el.className = `notice ${kind}`;
  el.innerHTML = html;
  el.classList.remove("hidden");
}

/** "2 h 10 min" from blocks. */
export function duration(blocks: number, blockSeconds = 1.42): string {
  const s = Math.max(0, Math.round(blocks * blockSeconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** uqor → "1.5 QOR". */
export function qor(uqor: string | bigint): string {
  const v = BigInt(uqor);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
}

/** Hash fragment parameters (codes and addresses travel in the fragment, never reaching server logs). */
export function fragment(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1));
}
