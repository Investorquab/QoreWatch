import { formatUnits, UQOR_DECIMALS, WEI_DECIMALS, type Coin } from "./amount.js";
import { evmToQor, isEvmAddress, shortAddress } from "./address.js";
import type { ChainEvent } from "./events.js";
import { FEE_COLLECTOR, moduleAccount } from "./modules.js";
import type { Tokens } from "./tokens.js";
import type { TxRecord } from "./tx.js";
import type { TokenLog } from "./evm.js";

/** How to name things in explanations. Output is Telegram-safe HTML. */
export interface ExplainContext {
  tokens: Tokens;
  /** The address the reader cares about: it is called "you". */
  viewer?: string;
  /** A label the user gave an address ("Treasury"), if any. */
  label?: (qor: string) => string | undefined;
  /** Average block time, for "in about N hours". */
  blockSeconds?: number;
  /** The current height, to turn expiry heights into durations. */
  height?: number;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Remove the HTML markup explanations carry. */
export const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** "you", a user label, a module name, or a short address. */
export function who(addr: string, ctx: ExplainContext): string {
  const q = isEvmAddress(addr) ? evmToQor(addr) : addr;
  if (ctx.viewer && q === ctx.viewer) return "you";
  const label = ctx.label?.(q);
  if (label) return `<b>${esc(label)}</b>`;
  const mod = moduleAccount(q);
  if (mod) return mod.label;
  return `<code>${esc(shortAddress(isEvmAddress(addr) ? addr : q, isEvmAddress(addr) ? 6 : 8, 4))}</code>`;
}

async function coins(cs: Coin[], ctx: ExplainContext): Promise<string> {
  const parts = await Promise.all(cs.map((c) => ctx.tokens.format(c.amount, c.denom)));
  return parts.join(" + ") || "nothing";
}

export const qor = (uqor: bigint) => `${formatUnits(uqor, UQOR_DECIMALS)} QOR`;
export const qorWei = (wei: bigint) => `${formatUnits(wei, WEI_DECIMALS)} QOR`;

/** "about 2 h 10 min" from a block count. */
export function duration(blocks: number, blockSeconds = 1.42): string {
  const s = Math.max(0, Math.round(blocks * blockSeconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** Friendly names for message types, for "is this safe?" and failed transactions. */
export function messageName(typeUrl: string): string {
  const names: Record<string, string> = {
    "/cosmos.bank.v1beta1.MsgSend": "a transfer",
    "/cosmos.bank.v1beta1.MsgMultiSend": "a multi-transfer",
    "/cosmos.authz.v1beta1.MsgGrant": "a permission grant (authz)",
    "/cosmos.authz.v1beta1.MsgRevoke": "a permission revoke (authz)",
    "/cosmos.authz.v1beta1.MsgExec": "an action on someone else's behalf (authz)",
    "/cosmos.feegrant.v1beta1.MsgGrantAllowance": "a fee allowance",
    "/cosmos.feegrant.v1beta1.MsgRevokeAllowance": "a fee allowance revoke",
    "/cosmos.staking.v1beta1.MsgDelegate": "a stake",
    "/cosmos.staking.v1beta1.MsgUndelegate": "an unstake",
    "/cosmos.staking.v1beta1.MsgBeginRedelegate": "a restake to another validator",
    "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": "a rewards claim",
    "/cosmos.gov.v1.MsgVote": "a governance vote",
    "/cosmos.gov.v1.MsgSubmitProposal": "a governance proposal",
    "/cosmos.gov.v1.MsgDeposit": "a proposal deposit",
    "/cosmos.evm.vm.v1.MsgEthereumTx": "an EVM transaction",
    "/cosmwasm.wasm.v1.MsgExecuteContract": "a CosmWasm contract call",
    "/qorechain.pqc.v1.MsgRegisterPQCKey": "a post-quantum key registration",
    "/qorechain.pqc.v1.MsgRegisterPQCKeyV2": "a post-quantum key registration",
    "/qorechain.pqc.v1.MsgRotatePQCKey": "a post-quantum key rotation",
    "/qorechain.pqc.v1.MsgMigratePQCKey": "a post-quantum key migration",
    "/qorechain.pqc.v1.MsgOpenEVMWindow": "opening an EVM spending window",
    "/qorechain.pqc.v1.MsgCloseEVMWindow": "closing an EVM spending window",
    "/qorechain.pqc.v1.MsgAuthorizeEVMDelegation": "an EVM delegation consent",
    "/qorechain.pqc.v1.MsgClearEVMDelegation": "clearing an EVM delegation",
    "/qorechain.pqc.v1.MsgRegisterKEMKey": "an encryption key registration",
    "/qorechain.pqc.v1.MsgRemoveKEMKey": "an encryption key removal",
    "/qorechain.abstractaccount.v1.MsgCreateAbstractAccount": "creating a smart account",
    "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator": "adding a session key (smart account)",
    "/qorechain.abstractaccount.v1.MsgRevokeAuthenticator": "removing a session key (smart account)",
    "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules": "changing smart-account spending rules",
    "/qorechain.abstractaccount.v1.MsgExecuteCosmos": "a smart-account action",
    "/qorechain.abstractaccount.v1.MsgExecuteEVM": "a smart-account EVM action",
    "/qorechain.amm.v1.MsgSwapExactIn": "a swap",
    "/qorechain.amm.v1.MsgSwapExactOut": "a swap",
    "/qorechain.amm.v1.MsgAddLiquidity": "adding pool liquidity",
    "/qorechain.amm.v1.MsgRemoveLiquidity": "removing pool liquidity",
    "/qorechain.crossvm.v1.MsgCrossVMCall": "a cross-VM call",
    "/qorechain.stakingtier.v1.MsgLockDelegation": "a staking tier lock",
    "/qorechain.stakingtier.v1.MsgUnlockEarly": "an early staking unlock",
  };
  if (names[typeUrl]) return names[typeUrl]!;
  const short = typeUrl.split(".").pop() ?? typeUrl;
  return short.replace(/^Msg/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** What an authz authorization allows, in words. */
export function authorizationText(a: Record<string, unknown> | undefined, msgTypeUrl: string): string {
  const type = String(a?.["@type"] ?? "");
  if (type.endsWith("SendAuthorization")) {
    const limit = (a?.spendLimit as { denom: string; amount: string }[] | undefined) ?? [];
    const l = limit.map((c) => (c.denom === "uqor" ? qor(BigInt(c.amount)) : `${c.amount} ${c.denom}`)).join(" + ");
    return l ? `send up to ${l} from the account` : "send from the account, with no limit";
  }
  if (type.endsWith("StakeAuthorization")) return "stake, unstake or restake your QOR";
  return `do ${messageName(msgTypeUrl || String(a?.msg ?? ""))} on the account's behalf, any number of times`;
}

/** One sentence for one chain event. */
export async function explainEvent(ev: ChainEvent, ctx: ExplainContext): Promise<string> {
  const h = (n: number) => (ctx.height ? `, ${n > ctx.height ? `for about ${duration(n - ctx.height, ctx.blockSeconds)} (until block ${n.toLocaleString("en-US")})` : `until block ${n.toLocaleString("en-US")}, already passed`}` : ` until block ${n.toLocaleString("en-US")}`);
  switch (ev.kind) {
    case "transfer":
      return `${cap(who(ev.from, ctx))} sent ${await coins(ev.coins, ctx)} to ${who(ev.to, ctx)}.`;
    case "window_opened": {
      const targets = ev.allowedTargets.length ? `only to ${ev.allowedTargets.map((t) => who(t, ctx)).join(", ")}` : "<b>to any recipient</b>";
      return `${cap(who(ev.address, ctx))} opened an EVM spending window: up to ${ev.maxTxs} transaction${ev.maxTxs === 1 ? "" : "s"} and ${qor(ev.maxValueUqor)} (amounts plus fees), ${targets}${h(ev.expiryHeight)}.`;
    }
    case "window_used":
      return `${cap(who(ev.address, ctx))} spent ${qor(ev.txValueUqor)} from an open window (${ev.usedTxs} transaction${ev.usedTxs === 1 ? "" : "s"} and ${qor(ev.usedValueUqor)} used so far).`;
    case "window_closed":
      return `${cap(who(ev.address, ctx))} closed the EVM spending window.`;
    case "pq_key_registered":
      return `${cap(who(ev.address, ctx))} registered a post-quantum key (${esc(algoName(ev.algorithm))}, ${esc(ev.keyType)}).`;
    case "pq_key_rotated":
      return `${cap(who(ev.address, ctx))} replaced the account's post-quantum key (${esc(algoName(ev.algorithm))}).`;
    case "pq_key_migrated":
      return `${cap(who(ev.address, ctx))} started moving the account to a new post-quantum key.`;
    case "kem_key_registered":
      return `${cap(who(ev.address, ctx))} ${ev.replaced ? "replaced" : "registered"} an encryption key (${esc(ev.algorithm.toUpperCase().replace("MLKEM", "ML-KEM-"))}).`;
    case "kem_key_removed":
      return `${cap(who(ev.address, ctx))} removed the account's encryption key.`;
    case "evm_delegation_consent":
      return `${cap(who(ev.address, ctx))} let ${who(ev.delegate, ctx)} act for the account's EVM address${h(ev.expiryHeight)}.`;
    case "evm_delegation_cleared":
      return `${cap(who(ev.address, ctx))} withdrew ${who(ev.delegate, ctx)}'s right to act for the EVM address.`;
    case "authz_grant":
      return `${cap(who(ev.granter, ctx))} allowed ${who(ev.grantee, ctx)} to ${authorizationText(ev.authorization, ev.msgTypeUrl)}${ev.expiration ? ` until ${fmtDate(ev.expiration)}` : ", with no end date"}.`;
    case "authz_revoke":
      return `${cap(who(ev.granter, ctx))} took back ${who(ev.grantee, ctx)}'s permission for ${messageName(ev.msgTypeUrl)}.`;
    case "authz_exec":
      return `${cap(who(ev.grantee, ctx))} used a permission to do ${ev.messages.map(messageName).join(", ")} on someone's behalf.`;
    case "feegrant_set":
      return `${cap(who(ev.granter, ctx))} agreed to pay ${who(ev.grantee, ctx)}'s transaction fees${allowanceText(ev.allowance)}.`;
    case "feegrant_revoke":
      return `${cap(who(ev.granter, ctx))} stopped paying ${who(ev.grantee, ctx)}'s fees.`;
    case "aa_created":
      return `${cap(who(ev.owner, ctx))} turned the account into a smart account${ev.accountType ? ` (${esc(ev.accountType)})` : ""}.`;
    case "aa_authenticator_added":
      return `${cap(who(ev.account, ctx))} added a session key (${esc(ev.scheme)})${ev.label ? ` called “${esc(ev.label)}”` : ""}${ev.permissions?.length ? ` that can ${esc(ev.permissions.join(", "))}` : ""}${ev.expiry ? ` until ${fmtDate(ev.expiry)}` : ""}.`;
    case "aa_authenticator_revoked":
      return `${cap(who(ev.account, ctx))} removed a session key (${esc(ev.scheme)}).`;
    case "aa_spending_rules":
      return `${cap(who(ev.account, ctx))} set smart-account spending rules: ${ev.rules
        .map((r) => `${esc(r.id)} ${r.enabled ? "" : "(off) "}${r.perTxLimit ? `${qor(BigInt(r.perTxLimit))} per transaction` : ""}${r.perTxLimit && r.dailyLimit ? ", " : ""}${r.dailyLimit ? `${qor(BigInt(r.dailyLimit))} a day` : ""}`.trim())
        .join("; ")}.`;
    case "classical_only":
      return `A transaction from ${who(ev.address, ctx)} carried <b>only a classical signature</b>, no post-quantum one.`;
    case "anomaly":
      return ev.flagged ? `QoreChain's built-in anomaly check flagged this transaction (score ${(ev.scoreMillionths / 10_000).toFixed(1)}%).` : `QoreChain's anomaly check passed.`;
    case "swap":
      return `${cap(who(ev.sender, ctx))} swapped ${await ctx.tokens.format(ev.amountIn, ev.denomIn)} for ${await ctx.tokens.format(ev.amountOut, ev.denomOut)} in pool ${esc(ev.poolId)}.`;
    case "liquidity":
      return `${cap(who(ev.sender, ctx))} ${ev.added ? "added" : "removed"} ${await coins(ev.coins, ctx)} ${ev.added ? "to" : "from"} pool ${esc(ev.poolId)}.`;
    case "delegate":
      return `${cap(who(ev.delegator, ctx))} staked ${await coins(ev.amount, ctx)} with <code>${esc(shortAddress(ev.validator, 14, 4))}</code>.`;
    case "unbond":
      return `${cap(who(ev.delegator, ctx))} started unstaking ${await coins(ev.amount, ctx)}; it is released on ${fmtDate(ev.completionTime)}.`;
    case "redelegate":
      return `${ev.delegator ? cap(who(ev.delegator, ctx)) : "Someone"} moved ${await coins(ev.amount, ctx)} of stake to another validator.`;
    case "rewards":
      return `${cap(who(ev.delegator, ctx))} claimed ${await coins(ev.amount, ctx)} in staking rewards.`;
    case "tier_lock":
      return `${cap(who(ev.delegator, ctx))} locked ${qor(ev.amountUqor)} of stake for ${ev.months} months (until ${fmtDate(ev.endTime)}).`;
    case "proposal_submitted":
      return `${ev.proposer ? cap(who(ev.proposer, ctx)) : "Someone"} submitted governance proposal #${esc(ev.proposalId)}${ev.messages.length ? ` (${esc(ev.messages.map((m) => m.split(".").pop()!).join(", "))})` : ""}.`;
    case "vote":
      return `${cap(who(ev.voter, ctx))} voted <b>${esc(ev.option)}</b> on proposal #${esc(ev.proposalId)}.`;
    case "deposit":
      return `${cap(who(ev.depositor, ctx))} deposited ${await coins(ev.amount, ctx)} on proposal #${esc(ev.proposalId)}.`;
    case "evm_tx":
      return `${ev.from ? cap(who(ev.from, ctx)) : "An account"} made an EVM transaction${ev.to ? ` to ${who(ev.to, ctx)}` : ""}${ev.amountWei > 0n ? ` sending ${qorWei(ev.amountWei)}` : ""}${ev.failed ? `, which <b>failed</b> (${esc(ev.failed)})` : ""}.`;
    case "crossvm":
      return `${cap(who(ev.sender, ctx))} called EVM contract ${who(ev.targetContract, ctx)} from the native lane.`;
    case "wasm":
      return `${ev.sender ? cap(who(ev.sender, ctx)) : "Someone"} called CosmWasm contract ${who(ev.contract, ctx)}${ev.action ? ` (${esc(ev.action.replace(/_/g, " "))})` : ""}.`;
  }
}

/** A token log (EVM side) in one sentence. */
export async function explainTokenLog(l: TokenLog, ctx: ExplainContext): Promise<string> {
  const t = await ctx.tokens.get(l.token);
  switch (l.kind) {
    case "token_transfer":
      if (/^0x0{40}$/.test(l.from)) return `${await ctx.tokens.format(l.value, l.token)} was minted to ${who(l.to, ctx)}.`;
      return `${cap(who(l.from, ctx))} sent ${await ctx.tokens.format(l.value, l.token)} to ${who(l.to, ctx)}.`;
    case "token_approval":
      if (l.value === 0n) return `${cap(who(l.owner, ctx))} removed ${who(l.spender, ctx)}'s permission to spend ${esc(t.symbol)}.`;
      return `${cap(who(l.owner, ctx))} allowed ${who(l.spender, ctx)} to spend ${l.unlimited ? `<b>all</b> of the account's ${esc(t.symbol)}, now and later` : `up to ${await ctx.tokens.format(l.value, l.token)}`}.`;
    case "nft_approval_all":
      return l.approved ? `${cap(who(l.owner, ctx))} let ${who(l.operator, ctx)} move <b>every</b> item of collection ${who(l.token, ctx)}.` : `${cap(who(l.owner, ctx))} removed ${who(l.operator, ctx)}'s access to collection ${who(l.token, ctx)}.`;
  }
}

/** Explain a whole transaction: a title and one line per meaningful thing that happened. */
export async function explainTx(tx: TxRecord, ctx: ExplainContext): Promise<{ title: string; lines: string[] }> {
  const lines: string[] = [];
  const shown = visibleEvents(tx);
  for (const ev of shown) lines.push(await explainEvent(ev, ctx));
  if (!shown.length || tx.failed) {
    for (const m of tx.messages) if (!lines.length || tx.failed) lines.push(`It asked for ${messageName(m.typeUrl)}.`);
  }
  const fee = netFee(tx);
  if (fee > 0n) lines.push(`Fee: ${tx.evmHash ? qorWei(fee) : qor(fee)}${tx.feeGranter ? ` (paid by ${who(tx.feeGranter, ctx)})` : ""}.`);
  if (tx.memo) lines.push(`Note: “${esc(tx.memo.slice(0, 200))}”`);
  const sig = tx.classicalOnly ? "Signed with a classical key only." : tx.hybridSigned ? "Signed with the hybrid post-quantum signature (ML-DSA-87)." : "";
  if (sig) lines.push(sig);
  const first = tx.messages[0];
  const what = first ? messageName(first.typeUrl) : "a transaction";
  const title = tx.failed ? `Failed: ${what}${tx.failReason ? ` (${esc(tx.failReason.slice(0, 120))})` : ""}` : cap(what);
  return { title, lines };
}

/** Module accounts whose transfer legs are already described by a richer event. */
const SEMANTIC_MODULES: Record<string, ChainEvent["kind"][]> = {
  amm: ["swap", "liquidity"],
  distribution: ["rewards"],
  gov: ["deposit"],
  bonded_tokens_pool: ["delegate", "unbond", "redelegate", "tier_lock"],
  not_bonded_tokens_pool: ["unbond"],
  stakingtier: ["tier_lock"],
};

/**
 * The events worth telling a person about: fee payments and refunds, EVM plumbing,
 * zero-amount legs, passed anomaly checks and transfers already covered by a richer
 * event (a swap, a rewards claim) are left out.
 */
export function visibleEvents(tx: TxRecord): ChainEvent[] {
  const kinds = new Set(tx.events.map((e) => e.kind));
  return tx.events.filter((e) => {
    if (e.kind === "anomaly") return e.flagged;
    if ((e.kind === "rewards" || e.kind === "delegate" || e.kind === "deposit") && e.amount.every((c) => c.amount === 0n)) return false;
    if (e.kind !== "transfer") return true;
    if (e.coins.every((c) => c.amount === 0n)) return false;
    if (e.to === FEE_COLLECTOR || e.from === FEE_COLLECTOR) return false;
    if (isPlumbing(e, tx)) return false;
    for (const side of [e.from, e.to]) {
      const m = moduleAccount(side)?.name;
      if (m && SEMANTIC_MODULES[m]?.some((k) => kinds.has(k))) return false;
    }
    return true;
  });
}

/** The fee actually paid: the fee charged minus any refund from the fee collector to the signer. */
export function netFee(tx: TxRecord): bigint {
  const charged = tx.fee.find((c) => c.denom === "uqor")?.amount ?? 0n;
  if (!tx.evmHash) return charged;
  // EVM fees are charged in 18-decimal units; refunds arrive as uqor transfers (6 decimals).
  let refund = 0n;
  for (const e of tx.events) if (e.kind === "transfer" && e.from === FEE_COLLECTOR && e.to === tx.signer) for (const c of e.coins) if (c.denom === "uqor") refund += c.amount;
  const net = charged - refund * 10n ** 12n;
  return net > 0n ? net : 0n;
}

/** Internal legs of EVM and module plumbing (into and out of the EVM module, mint/burn). */
function isPlumbing(e: ChainEvent, tx: TxRecord): boolean {
  if (e.kind !== "transfer") return false;
  const m1 = moduleAccount(e.from)?.name;
  const m2 = moduleAccount(e.to)?.name;
  return !!tx.evmHash && (m1 === "evm" || m2 === "evm");
}

function allowanceText(a?: Record<string, unknown>): string {
  if (!a) return "";
  const type = String(a["@type"] ?? "");
  const inner = (type.endsWith("AllowedMsgAllowance") ? (a.allowance as Record<string, unknown>) : a) ?? {};
  const limit = (inner.spendLimit as { denom: string; amount: string }[] | undefined) ?? [];
  const l = limit.find((c) => c.denom === "uqor");
  const exp = inner.expiration as string | undefined;
  return `${l ? ` (up to ${qor(BigInt(l.amount))})` : " (no limit)"}${exp ? ` until ${fmtDate(exp)}` : ""}`;
}

function algoName(a: string): string {
  return a === "dilithium5" ? "ML-DSA-87" : a;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const cap = (s: string) => (s.startsWith("<") || !s ? s : s[0]!.toUpperCase() + s.slice(1));
