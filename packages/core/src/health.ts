import type { Coin } from "./amount.js";
import { authorizationText, duration, esc, fmtDate, qor } from "./explain.js";
import type { AbstractAccount, AuthAccount, AuthzGrant, EvmWindow, FeeAllowance, PqcAccount, Rest } from "./rest.js";

export type Severity = "critical" | "warning" | "info" | "good";

/** How a finding can be fixed: in QoreX itself, or with one tap on a QoreWatch page. */
export type Fix =
  | { kind: "qorex_register_key" }
  | { kind: "qorex_close_window" }
  | { kind: "revoke_authz"; grantee: string; msgTypeUrl: string }
  | { kind: "revoke_feegrant"; grantee: string };

export interface Finding {
  id: string;
  severity: Severity;
  /** Short, HTML-safe title. */
  title: string;
  /** One or two sentences, Telegram HTML. */
  detail: string;
  /** Points taken off the score. */
  penalty: number;
  fix?: Fix;
}

export type HealthStatus = "ready" | "attention" | "at_risk" | "unused";

export interface HealthReport {
  address: string;
  status: HealthStatus;
  /** 0 to 100. */
  score: number;
  findings: Finding[];
  pqc: PqcAccount;
  auth: AuthAccount;
  window: EvmWindow;
  grants: AuthzGrant[];
  feeAllowances: FeeAllowance[];
  smartAccount?: AbstractAccount;
  kem: { found: boolean; algorithm?: string };
  balances: Coin[];
  /** When the report was made, ISO. */
  checkedAt: string;
}

export interface HealthInput {
  address: string;
  pqc: PqcAccount;
  auth: AuthAccount;
  window: EvmWindow;
  grants: AuthzGrant[];
  feeAllowances: FeeAllowance[];
  smartAccount?: AbstractAccount;
  kem: { found: boolean; algorithm?: string };
  balances: Coin[];
  /** Extra findings from the caller (e.g. token approvals it has seen). */
  extra?: Finding[];
  blockSeconds?: number;
  now?: Date;
}

/** Read everything a check needs from the chain, in parallel. */
export async function readHealthInput(rest: Rest, address: string): Promise<HealthInput> {
  const [pqc, auth, window, grants, feeAllowances, smartAccount, kem, balances] = await Promise.all([
    rest.pqcAccount(address),
    rest.authAccount(address),
    rest.evmWindow(address),
    rest.grantsByGranter(address).catch(() => []),
    rest.feeAllowancesIssued(address).catch(() => []),
    rest.abstractAccount(address).catch(() => undefined),
    rest.kemKey(address).catch(() => ({ found: false })),
    rest.balances(address).catch(() => []),
  ]);
  return { address, pqc, auth, window, grants, feeAllowances, ...(smartAccount ? { smartAccount } : {}), kem, balances };
}

/** Score an account's post-quantum safety and list what to fix, most serious first. */
export function assess(input: HealthInput): HealthReport {
  const f: Finding[] = [];
  const { pqc, auth, window: w, grants, feeAllowances, smartAccount } = input;
  const now = input.now ?? new Date();

  if (!auth.exists && !pqc.found && input.balances.length === 0) {
    return { ...base(input, now), status: "unused", score: 0, findings: [{ id: "unused", severity: "info", title: "No activity yet", detail: "This address has never been used on QoreChain: no balance, no transactions, no keys.", penalty: 0 }] };
  }

  if (!pqc.found) {
    f.push(
      auth.classicalKeyExposed
        ? {
            id: "no_pq_key_exposed",
            severity: "critical",
            title: "No post-quantum key, and the classical key is public",
            detail: "This account has signed before, so its classical public key is on chain. With no ML-DSA-87 key registered, whoever first derives the classical key can register their own post-quantum key and take the account over.",
            penalty: 60,
            fix: { kind: "qorex_register_key" },
          }
        : {
            id: "no_pq_key",
            severity: "critical",
            title: "No post-quantum key registered",
            detail: "Register an ML-DSA-87 key now, while only you can. Until then the account is protected by its classical key alone.",
            penalty: 45,
            fix: { kind: "qorex_register_key" },
          },
    );
  } else {
    f.push({ id: "pq_key", severity: "good", title: "Post-quantum key registered", detail: `ML-DSA-87 (${esc(pqc.keyType ?? "hybrid")})${pqc.createdAtHeight ? `, since block ${pqc.createdAtHeight.toLocaleString("en-US")}` : ""}. Every transaction needs it.`, penalty: 0 });
    if (pqc.possessionProven === false)
      f.push({ id: "no_pop", severity: "info", title: "Key registered without proof of possession", detail: "The key was registered without proving the account holds it. Rotating it in QoreX adds the proof.", penalty: 5 });
    if (pqc.migrating)
      f.push({ id: "migrating", severity: "warning", title: "A key migration is in progress", detail: "A new post-quantum key is waiting to replace the current one. If you did not start this, treat it as a takeover attempt.", penalty: 15 });
    if (auth.classicalKeyExposed)
      f.push({ id: "classical_public", severity: "info", title: "Classical public key is on chain", detail: "Normal after the first transaction. Your post-quantum key is what protects the account.", penalty: 0 });
  }

  if (w.found && w.live) {
    const any = w.allowedTargets.length === 0;
    const left = w.remainingValueUqor !== undefined ? qor(w.remainingValueUqor) : "an unknown amount";
    f.push({
      id: "window_open",
      severity: any ? "warning" : "info",
      title: any ? "An EVM spending window is open to any recipient" : "An EVM spending window is open",
      detail: `${w.remainingTxs ?? "?"} transaction${w.remainingTxs === 1 ? "" : "s"} and ${left} can still be spent${any ? " to any address" : ` to ${w.allowedTargets.length} allowed contract${w.allowedTargets.length === 1 ? "" : "s"}`}${w.remainingBlocks ? `, for about ${duration(w.remainingBlocks, input.blockSeconds)}` : ""}. While it is open, the classical key alone can spend it.`,
      penalty: any ? 20 : 8,
      fix: { kind: "qorex_close_window" },
    });
  }

  let grantPenalty = 0;
  for (const g of grants) {
    const expired = g.expiration && new Date(g.expiration) < now;
    if (expired) continue;
    const p = Math.min(10, 30 - grantPenalty);
    grantPenalty += p;
    f.push({
      id: `authz:${g.grantee}:${g.msgTypeUrl ?? ""}`,
      severity: "warning",
      title: "Someone can act for this account",
      detail: `<code>${esc(g.grantee.slice(0, 12))}…${esc(g.grantee.slice(-4))}</code> may ${authorizationText(g.authorization, g.msgTypeUrl ?? "")}${g.expiration ? ` until ${fmtDate(g.expiration)}` : ", with no end date"}.`,
      penalty: p,
      fix: { kind: "revoke_authz", grantee: g.grantee, msgTypeUrl: g.msgTypeUrl ?? String(g.authorization.msg ?? "") },
    });
  }

  let feePenalty = 0;
  for (const a of feeAllowances) {
    const p = Math.min(3, 9 - feePenalty);
    feePenalty += p;
    f.push({
      id: `feegrant:${a.grantee}`,
      severity: "info",
      title: "This account pays someone's fees",
      detail: `<code>${esc(a.grantee.slice(0, 12))}…${esc(a.grantee.slice(-4))}</code> can spend this account's QOR on transaction fees.`,
      penalty: p,
      fix: { kind: "revoke_feegrant", grantee: a.grantee },
    });
  }

  if (smartAccount && (smartAccount.sessionKeysCount > 0 || smartAccount.authenticatorsCount > 0))
    f.push({
      id: "session_keys",
      severity: "info",
      title: "Smart account with session keys",
      detail: `${smartAccount.sessionKeysCount + smartAccount.authenticatorsCount} extra key${smartAccount.sessionKeysCount + smartAccount.authenticatorsCount === 1 ? "" : "s"} can sign for this account within its ${smartAccount.spendingRulesCount} spending rule${smartAccount.spendingRulesCount === 1 ? "" : "s"}.`,
      penalty: 5,
    });

  for (const x of input.extra ?? []) f.push(x);

  const score = Math.max(0, Math.min(100, 100 - f.reduce((n, x) => n + x.penalty, 0)));
  const critical = f.some((x) => x.severity === "critical");
  const warnings = f.some((x) => x.severity === "warning");
  const status: HealthStatus = critical || score < 50 ? "at_risk" : warnings || score < 85 ? "attention" : "ready";
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  f.sort((a, b) => order[a.severity] - order[b.severity] || b.penalty - a.penalty);
  return { ...base(input, now), status, score, findings: f };
}

function base(input: HealthInput, now: Date) {
  return {
    address: input.address,
    pqc: input.pqc,
    auth: input.auth,
    window: input.window,
    grants: input.grants,
    feeAllowances: input.feeAllowances,
    ...(input.smartAccount ? { smartAccount: input.smartAccount } : {}),
    kem: input.kem,
    balances: input.balances,
    checkedAt: now.toISOString(),
  };
}

export const STATUS_LABEL: Record<HealthStatus, string> = {
  ready: "Quantum-ready",
  attention: "Needs attention",
  at_risk: "At risk",
  unused: "Not used yet",
};
