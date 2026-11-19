import {
  assess,
  buildTx,
  classify,
  esc,
  explainTx,
  formatUnits,
  isAccount,
  moduleAccount,
  qorToEvm,
  readHealthInput,
  shortAddress,
  UNLIMITED,
  type ExplainContext,
  type Finding,
  type HealthReport,
  type Lookup,
  type TxRecord,
} from "@qorewatch/core";
import type { Chain } from "./chain.js";
import type { Store } from "./db/store.js";
import type { Button } from "./alerts/types.js";
import { explorer, pages } from "./links.js";
import { checkReport, type View } from "./telegram/views.js";

export interface LookupDeps {
  chain: Chain;
  store: Store;
  publicUrl: string;
}

/** Resolve user input (address, 0x, @handle) to a qor1 address, or explain why not. */
export async function resolveAddress(deps: LookupDeps, input: string): Promise<{ address: string; handle?: string } | { error: string }> {
  const l = classify(input);
  if (l.kind === "address") return { address: l.qor };
  if (l.kind === "handle") {
    try {
      const rec = await deps.chain.handles.resolve(l.handle);
      if (!rec) return { error: `Nobody has claimed <b>@${esc(l.handle)}</b> in QoreX yet.` };
      return { address: rec.qorAddress, handle: l.handle };
    } catch (e) {
      return { error: `I could not verify <b>@${esc(l.handle)}</b>: ${esc((e as Error).message)}` };
    }
  }
  if (l.kind === "tx") return { error: "That looks like a transaction hash. Use /tx with it." };
  return { error: "That is not a QoreChain address. Send a <code>qor1…</code> or <code>0x…</code> address, or a QoreX <code>@handle</code>." };
}

/** The labels a chat gave its watches, for explanations. */
export function labeller(store: Store, chatId: number): (a: string) => string | undefined {
  const map = new Map(store.watches(chatId).map((w) => [w.address, w.label ?? undefined]));
  return (a) => map.get(a);
}

/** Findings from token approvals QoreWatch has seen for this owner (EVM side). */
export async function approvalFindings(deps: LookupDeps, address: string): Promise<Finding[]> {
  if (!isAccount(address)) return [];
  const owner = qorToEvm(address);
  const out: Finding[] = [];
  for (const a of deps.store.approvals(owner).slice(0, 5)) {
    // Confirm the approval is still live before reporting it.
    const live = await deps.chain.evm.allowance(a.token, owner, a.spender).catch(() => a.value);
    if (live === 0n) {
      deps.store.setApproval(owner, a.token, a.spender, 0n, a.block, a.tx);
      continue;
    }
    const t = await deps.chain.tokens.get(a.token);
    out.push({
      id: `approval:${a.token}:${a.spender}`,
      severity: live >= UNLIMITED ? "warning" : "info",
      title: live >= UNLIMITED ? `Unlimited ${esc(t.symbol)} approval` : `${esc(t.symbol)} approval`,
      detail: `<code>${esc(shortAddress(a.spender, 6, 4))}</code> can take ${live >= UNLIMITED ? `<b>all</b> of this account's ${esc(t.symbol)}` : `up to ${formatUnits(live, t.decimals)} ${esc(t.symbol)}`} without asking again.`,
      penalty: live >= UNLIMITED ? 10 : 3,
    });
  }
  return out;
}

export async function runCheck(deps: LookupDeps, address: string): Promise<HealthReport> {
  const input = await readHealthInput(deps.chain.rest, address);
  return assess({ ...input, extra: await approvalFindings(deps, address), blockSeconds: deps.chain.cfg.blockSeconds });
}

export async function checkView(deps: LookupDeps, chatId: number, input: string): Promise<View> {
  const r = await resolveAddress(deps, input);
  if ("error" in r) return { html: r.error };
  const report = await runCheck(deps, r.address);
  const handle = r.handle ?? (await deps.chain.handles.reverse(r.address));
  const extra = report.findings.filter((f) => f.id.startsWith("approval:"));
  const view = await checkReport(report, deps.chain.tokens, deps.publicUrl, { ...(handle ? { handle } : {}), watched: !!deps.store.watch(chatId, r.address) });
  if (extra.length && isAccount(r.address)) {
    const owner = qorToEvm(r.address);
    const p = pages(deps.publicUrl);
    for (const f of extra) {
      const [, token, spender] = f.id.split(":");
      view.buttons!.unshift([{ text: `🛠 Revoke ${f.title.replace(/<[^>]+>/g, "")}`, url: p.fixApproval(owner, token!, spender!) }]);
    }
  }
  return view;
}

/** Find a transaction by Cosmos hash or EVM hash. */
export async function fetchTx(deps: LookupDeps, hash: string): Promise<TxRecord | undefined> {
  const h = hash.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) {
    const found = await deps.chain.rpc.search(`ethereum_tx.ethereumTxHash='${h.toLowerCase()}'`, 1);
    const raw = found.txs[0];
    return raw ? buildTx(raw) : undefined;
  }
  const raw = await deps.chain.rpc.tx(h.toUpperCase());
  return raw ? buildTx(raw) : undefined;
}

export function explainCtx(deps: LookupDeps, chatId: number, viewer?: string, height?: number): ExplainContext {
  return { tokens: deps.chain.tokens, label: labeller(deps.store, chatId), blockSeconds: deps.chain.cfg.blockSeconds, ...(viewer ? { viewer } : {}), ...(height ? { height } : {}) };
}

export async function txView(deps: LookupDeps, chatId: number, hash: string): Promise<View> {
  const tx = await fetchTx(deps, hash);
  if (!tx) return { html: "I could not find that transaction on QoreChain testnet. Check the hash, or wait a few seconds if it was just sent." };
  const status = await deps.chain.rpc.status().catch(() => undefined);
  const e = await explainTx(tx, explainCtx(deps, chatId, undefined, status?.height));
  const flags = riskFlags(tx);
  return {
    html: [
      `🧾 <b>${e.title}</b>`,
      `Block ${tx.height.toLocaleString("en-US")} · ${tx.time.slice(0, 16).replace("T", " ")} UTC`,
      "",
      ...e.lines.map((l) => `• ${l}`),
      ...(flags.length ? ["", ...flags] : []),
    ].join("\n"),
    buttons: txButtons(deps, tx),
  };
}

export function txButtons(deps: LookupDeps, tx: TxRecord): Button[][] {
  return [[{ text: "🔎 Details", url: pages(deps.publicUrl).tx(tx.hash) }, { text: "🌐 Explorer (pick Testnet)", url: explorer(deps.chain.cfg.explorer).tx(tx.hash) }]];
}

/** Things in a transaction that deserve a second look before (or after) signing. */
export function riskFlags(tx: TxRecord): string[] {
  const f: string[] = [];
  for (const ev of tx.events) {
    if (ev.kind === "authz_grant") f.push("⚠️ It gives another account permission to act for the signer.");
    if (ev.kind === "feegrant_set") f.push("⚠️ It lets another account spend the signer's QOR on fees.");
    if (ev.kind === "window_opened" && ev.allowedTargets.length === 0) f.push("⚠️ It opens a spending window to <b>any</b> recipient.");
    if (ev.kind === "evm_delegation_consent") f.push("⚠️ It lets another EVM address act for the account.");
    if (ev.kind === "aa_authenticator_added") f.push("⚠️ It adds a session key that can sign for the account.");
    if (ev.kind === "pq_key_rotated" || ev.kind === "pq_key_migrated") f.push("🔴 It changes the account's post-quantum key.");
    if (ev.kind === "classical_only") f.push("🟠 It carried only a classical signature.");
    if (ev.kind === "anomaly" && ev.flagged) f.push("🔴 QoreChain's own anomaly check flagged it.");
  }
  return [...new Set(f)];
}

export async function historyView(deps: LookupDeps, chatId: number, input: string, limit = 5): Promise<View> {
  const r = await resolveAddress(deps, input);
  if ("error" in r) return { html: r.error };
  const raws = await deps.chain.rpc.recentForAddress(r.address, limit);
  if (!raws.length) return { html: `No transactions found for <code>${esc(shortAddress(r.address, 10, 6))}</code>.` };
  const viewer = deps.store.watch(chatId, r.address)?.owned ? r.address : undefined;
  const ctx = explainCtx(deps, chatId, viewer);
  const lines = [`🧾 <b>Last ${raws.length} transaction${raws.length === 1 ? "" : "s"}</b> · <code>${esc(shortAddress(r.address, 10, 6))}</code>`, ""];
  const buttons: Button[][] = [];
  for (const raw of raws) {
    const tx = await buildTx(raw);
    const e = await explainTx(tx, { ...ctx, viewer: r.address });
    lines.push(`<b>${e.title}</b> · ${tx.time.slice(5, 16).replace("T", " ")}`, ...(e.lines[0] ? [e.lines[0]] : []), "");
    buttons.push([{ text: `🔎 ${tx.hash.slice(0, 10)}… details`, url: pages(deps.publicUrl).tx(tx.hash) }]);
  }
  return { html: lines.join("\n").trim(), buttons };
}

/**
 * "Is this safe?" for something pasted or forwarded: an address gets a quick profile
 * (contract, module, new, post-quantum key), a transaction gets its explanation and flags.
 */
export async function safetyView(deps: LookupDeps, chatId: number, l: Lookup): Promise<View> {
  if (l.kind === "tx") return txView(deps, chatId, l.hash);
  if (l.kind === "unknown") return { html: "I did not find an address or a transaction in that." };
  const r = l.kind === "address" ? { address: l.qor } : await resolveAddress(deps, l.input);
  if ("error" in r) return { html: r.error };
  const a = r.address;
  const mod = moduleAccount(a);
  const notes: string[] = [];
  let verdict = "🟢 Nothing unusual found";
  if (mod) {
    notes.push(`This is ${mod.label}, a QoreChain module account. Nobody holds its key.`);
    verdict = "🔵 Module account";
  } else if (!isAccount(a)) {
    notes.push("This is a CosmWasm contract address, not a person's wallet.");
    verdict = "🔵 Contract";
  } else {
    const evm = qorToEvm(a);
    const [auth, pqc, contract, handle] = await Promise.all([
      deps.chain.rest.authAccount(a),
      deps.chain.rest.pqcAccount(a),
      deps.chain.evm.isContract(evm).catch(() => false),
      deps.chain.handles.reverse(a),
    ]);
    if (contract) {
      notes.push(`This is an <b>EVM contract</b> (<code>${esc(shortAddress(evm, 6, 4))}</code>). Sending tokens to it, or approving it, gives control to its code.`);
      verdict = "🟠 Contract: check what it does";
    } else if (!auth.exists) {
      notes.push("This address has <b>never been used</b> on QoreChain. Double-check it with the person before sending money, especially if it was pasted or forwarded.");
      verdict = "🟠 Brand-new address";
    } else {
      notes.push(`It has sent ${auth.sequence} transaction${auth.sequence === 1 ? "" : "s"}.`);
      notes.push(pqc.found ? "It has a post-quantum key registered." : "It has <b>no post-quantum key</b> yet.");
      if (!pqc.found) verdict = "🟠 Active, but not quantum-ready";
    }
    if (handle) notes.push(`QoreX handle: <b>@${esc(handle)}</b> (verified).`);
  }
  return {
    html: [`🛡 <b>Is this safe?</b>`, `<code>${esc(a)}</code>`, "", `<b>${verdict}</b>`, ...notes.map((n) => `• ${n}`), "", "Scam addresses often look almost like real ones. Compare the first and last characters."].join("\n"),
    buttons: [
      [
        { text: "🩺 Full check", data: `c:${a}` },
        { text: "🧾 History", data: `h:${a}` },
      ],
      ...(deps.store.watch(chatId, a) ? [] : [[{ text: "👁 Watch it", data: `watch:${a}` }]]),
    ],
  };
}
