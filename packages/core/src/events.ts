import { parseCoins, type Coin } from "./amount.js";
import type { DecodedMsg } from "./decode.js";
import { evmToQor, isEvmAddress, isQorAddress } from "./address.js";

/** An ABCI event as CometBFT serves it. */
export interface AbciEvent {
  type: string;
  attributes: { key: string; value: string; index?: boolean }[];
}

/**
 * Everything QoreWatch recognises on chain, as typed records. Each carries the
 * addresses it concerns, so alerts can be routed to whoever watches them.
 * Adding a new kind: add it to this union, parse it in `parseEvents` (or
 * `fromMessages` for message-only facts), and give it a sentence in explain.ts.
 */
export type ChainEvent =
  | { kind: "transfer"; from: string; to: string; coins: Coin[] }
  | { kind: "window_opened"; address: string; expiryHeight: number; maxTxs: number; maxValueUqor: bigint; allowedTargets: string[] }
  | { kind: "window_used"; address: string; evmAddress: string; windowOpenHeight: number; usedTxs: number; usedValueUqor: bigint; txValueUqor: bigint }
  | { kind: "window_closed"; address: string }
  | { kind: "pq_key_registered"; address: string; keyType: string; algorithm: string }
  | { kind: "pq_key_rotated"; address: string; algorithm: string }
  | { kind: "pq_key_migrated"; address: string }
  | { kind: "kem_key_registered"; address: string; algorithm: string; replaced: boolean }
  | { kind: "kem_key_removed"; address: string }
  | { kind: "evm_delegation_consent"; address: string; delegate: string; expiryHeight: number }
  | { kind: "evm_delegation_cleared"; address: string; delegate: string }
  | { kind: "authz_grant"; granter: string; grantee: string; msgTypeUrl: string; authorization?: Record<string, unknown>; expiration?: string }
  | { kind: "authz_revoke"; granter: string; grantee: string; msgTypeUrl: string }
  | { kind: "authz_exec"; grantee: string; messages: string[] }
  | { kind: "feegrant_set"; granter: string; grantee: string; allowance?: Record<string, unknown> }
  | { kind: "feegrant_revoke"; granter: string; grantee: string }
  | { kind: "aa_created"; owner: string; account: string; accountType?: string }
  | { kind: "aa_authenticator_added"; account: string; scheme: string; expiry?: string; permissions?: string[]; label?: string }
  | { kind: "aa_authenticator_revoked"; account: string; scheme: string }
  | { kind: "aa_spending_rules"; account: string; rules: { id: string; dailyLimit?: string; perTxLimit?: string; denoms: string[]; enabled: boolean }[] }
  | { kind: "classical_only"; address: string }
  | { kind: "anomaly"; scoreMillionths: number; flagged: boolean; action: string }
  | { kind: "swap"; sender: string; poolId: string; denomIn: string; amountIn: bigint; denomOut: string; amountOut: bigint }
  | { kind: "liquidity"; sender: string; poolId: string; added: boolean; coins: Coin[] }
  | { kind: "delegate"; delegator: string; validator: string; amount: Coin[] }
  | { kind: "unbond"; delegator: string; validator: string; amount: Coin[]; completionTime: string }
  | { kind: "redelegate"; delegator?: string; from: string; to: string; amount: Coin[]; completionTime: string }
  | { kind: "rewards"; delegator: string; validator: string; amount: Coin[] }
  | { kind: "tier_lock"; delegator: string; validator: string; amountUqor: bigint; months: number; endTime: string }
  | { kind: "proposal_submitted"; proposalId: string; proposer?: string; messages: string[] }
  | { kind: "vote"; voter: string; proposalId: string; option: string }
  | { kind: "deposit"; depositor: string; proposalId: string; amount: Coin[] }
  | { kind: "evm_tx"; hash: string; from?: string; to?: string; amountWei: bigint; failed?: string; gasUsed?: bigint }
  | { kind: "crossvm"; sender: string; targetContract: string; status?: string }
  | { kind: "wasm"; contract: string; action?: string; sender?: string };

export type ChainEventKind = ChainEvent["kind"];

const unquote = (v: string) => {
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
};

function attrs(e: AbciEvent): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of e.attributes) if (a.key !== "msg_index" && !(a.key in o)) o[a.key] = unquote(a.value);
  return o;
}

const num = (s: string | undefined) => (s ? Number(s) : 0);
const big = (s: string | undefined) => {
  try {
    return s ? BigInt(s) : 0n;
  } catch {
    return 0n;
  }
};

/**
 * Turn a transaction's ABCI events into typed records. Fee payments to the fee
 * collector are kept as transfers (the caller decides what to show); module-internal
 * mint/burn legs are dropped.
 */
export function parseEvents(events: AbciEvent[]): ChainEvent[] {
  const out: ChainEvent[] = [];
  let evmSender: string | undefined;
  for (const e of events) {
    const a = attrs(e);
    switch (e.type) {
      case "message":
        if (a.module === "evm" && a.sender && isEvmAddress(a.sender)) evmSender = a.sender.toLowerCase();
        break;
      case "transfer":
        if (a.sender && a.recipient) out.push({ kind: "transfer", from: a.sender, to: a.recipient, coins: parseCoins(a.amount) });
        break;
      case "pqc_evm_window_opened":
        out.push({
          kind: "window_opened",
          address: a.address!,
          expiryHeight: num(a.expiry_height),
          maxTxs: num(a.max_txs),
          maxValueUqor: big(a.max_value),
          allowedTargets: a.allowed_targets ? a.allowed_targets.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
        });
        break;
      case "pqc_evm_window_used":
        out.push({
          kind: "window_used",
          address: a.address!,
          evmAddress: (a.evm_address ?? "").toLowerCase(),
          windowOpenHeight: num(a.window_open_height),
          usedTxs: num(a.used_txs),
          usedValueUqor: big(a.used_value),
          txValueUqor: big(a.tx_value),
        });
        break;
      case "pqc_evm_window_closed":
        out.push({ kind: "window_closed", address: a.address! });
        break;
      case "pqc_key_registered":
        out.push({ kind: "pq_key_registered", address: a.address!, keyType: a.key_type ?? "", algorithm: a.algorithm_id ?? "" });
        break;
      case "pqc_key_rotated":
        out.push({ kind: "pq_key_rotated", address: a.address!, algorithm: a.algorithm_id ?? "" });
        break;
      case "pqc_key_migrated":
        out.push({ kind: "pq_key_migrated", address: a.address! });
        break;
      case "pqc_kem_key_registered":
        out.push({ kind: "kem_key_registered", address: a.address!, algorithm: a.algorithm_id ?? "", replaced: a.replaced === "true" });
        break;
      case "pqc_kem_key_removed":
        out.push({ kind: "kem_key_removed", address: a.address! });
        break;
      case "pqc_evm_delegation_consent":
        out.push({ kind: "evm_delegation_consent", address: a.address!, delegate: (a.delegate ?? "").toLowerCase(), expiryHeight: num(a.expiry_height) });
        break;
      case "pqc_evm_delegation_cleared":
        out.push({ kind: "evm_delegation_cleared", address: a.address!, delegate: (a.delegate ?? "").toLowerCase() });
        break;
      case "cosmos.authz.v1beta1.EventGrant":
        out.push({ kind: "authz_grant", granter: a.granter!, grantee: a.grantee!, msgTypeUrl: a.msg_type_url ?? "" });
        break;
      case "cosmos.authz.v1beta1.EventRevoke":
        out.push({ kind: "authz_revoke", granter: a.granter!, grantee: a.grantee!, msgTypeUrl: a.msg_type_url ?? "" });
        break;
      case "set_feegrant":
      case "update_feegrant":
        out.push({ kind: "feegrant_set", granter: a.granter!, grantee: a.grantee! });
        break;
      case "revoke_feegrant":
        out.push({ kind: "feegrant_revoke", granter: a.granter!, grantee: a.grantee! });
        break;
      case "aa_register_authenticator":
        out.push({ kind: "aa_authenticator_added", account: a.account!, scheme: a.scheme ?? "", ...(a.expiry ? { expiry: a.expiry } : {}) });
        break;
      case "aa_revoke_authenticator":
        out.push({ kind: "aa_authenticator_revoked", account: a.account!, scheme: a.scheme ?? "" });
        break;
      case "pqc_hybrid_classical_only":
        if (a.address) out.push({ kind: "classical_only", address: a.address });
        break;
      case "ai_anomaly_check":
        out.push({ kind: "anomaly", scoreMillionths: num(a.score_millionths), flagged: a.is_anomalous === "true", action: a.action ?? "" });
        break;
      case "amm_swap":
        out.push({ kind: "swap", sender: a.sender!, poolId: a.pool_id ?? "", denomIn: a.denom_in ?? "", amountIn: big(a.amount_in), denomOut: a.denom_out ?? "", amountOut: big(a.amount_out) });
        break;
      case "amm_liquidity_added":
        out.push({ kind: "liquidity", sender: a.sender!, poolId: a.pool_id ?? "", added: true, coins: parseCoins(a.tokens_in) });
        break;
      case "amm_liquidity_removed":
        out.push({ kind: "liquidity", sender: a.sender!, poolId: a.pool_id ?? "", added: false, coins: parseCoins(a.tokens_out) });
        break;
      case "delegate":
        if (a.delegator) out.push({ kind: "delegate", delegator: a.delegator, validator: a.validator ?? "", amount: parseCoins(a.amount) });
        break;
      case "unbond":
        if (a.delegator) out.push({ kind: "unbond", delegator: a.delegator, validator: a.validator ?? "", amount: parseCoins(a.amount), completionTime: a.completion_time ?? "" });
        break;
      case "redelegate":
        out.push({ kind: "redelegate", ...(a.delegator ? { delegator: a.delegator } : {}), from: a.source_validator ?? "", to: a.destination_validator ?? "", amount: parseCoins(a.amount), completionTime: a.completion_time ?? "" });
        break;
      case "withdraw_rewards":
        if (a.delegator) out.push({ kind: "rewards", delegator: a.delegator, validator: a.validator ?? "", amount: parseCoins(a.amount) });
        break;
      case "staking_tier_lock_created":
        out.push({
          kind: "tier_lock",
          delegator: a.delegator!,
          validator: a.validator ?? "",
          amountUqor: big(a.amount),
          months: num(a.months),
          endTime: a.end_time && /^\d+$/.test(a.end_time) ? new Date(Number(a.end_time) * 1000).toISOString() : (a.end_time ?? ""),
        });
        break;
      case "submit_proposal":
        if (a.proposal_id)
          out.push({
            kind: "proposal_submitted",
            proposalId: a.proposal_id,
            ...(a.proposal_proposer ? { proposer: a.proposal_proposer } : {}),
            messages: (a.proposal_messages ?? "").split(",").filter(Boolean),
          });
        break;
      case "proposal_vote":
        out.push({ kind: "vote", voter: a.voter!, proposalId: a.proposal_id ?? "", option: voteOption(a.option ?? "") });
        break;
      case "proposal_deposit":
        if (a.depositor) out.push({ kind: "deposit", depositor: a.depositor, proposalId: a.proposal_id ?? "", amount: parseCoins(a.amount) });
        break;
      case "ethereum_tx":
        if (a.ethereumTxHash && (a.txHash || a.recipient || a.amount || a.ethereumTxFailed)) {
          out.push({
            kind: "evm_tx",
            hash: a.ethereumTxHash.toLowerCase(),
            ...(evmSender ? { from: evmSender } : {}),
            ...(a.recipient ? { to: a.recipient.toLowerCase() } : {}),
            amountWei: big(a.amount),
            ...(a.ethereumTxFailed ? { failed: a.ethereumTxFailed } : {}),
            ...(a.txGasUsed ? { gasUsed: big(a.txGasUsed) } : {}),
          });
        }
        break;
      case "crossvm_request":
        out.push({ kind: "crossvm", sender: a.sender ?? "", targetContract: (a.target_contract ?? "").toLowerCase() });
        break;
      case "wasm":
        if (a._contract_address) out.push({ kind: "wasm", contract: a._contract_address, ...(a.action ? { action: a.action } : {}), ...(a.owner || a.sender ? { sender: a.owner ?? a.sender } : {}) });
        break;
    }
  }
  // An EVM tx's sender can arrive after its ethereum_tx event; fill it in.
  if (evmSender) for (const ev of out) if (ev.kind === "evm_tx" && !ev.from) ev.from = evmSender;
  return out;
}

function voteOption(raw: string): string {
  const names: Record<string, string> = { "1": "Yes", "2": "Abstain", "3": "No", "4": "No with veto" };
  try {
    const arr = JSON.parse(raw) as { option: number | string; weight: string }[];
    return arr.map((o) => names[String(o.option)] ?? String(o.option)).join(", ");
  } catch {
    return names[raw] ?? raw;
  }
}

/**
 * Facts only the message body carries (no event, or the event lacks detail):
 * spending rules, account creation, authz/feegrant details, key migration, KEM
 * removal. Also used for failed transactions, whose message events are dropped.
 */
export function fromMessages(messages: DecodedMsg[]): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const m of messages) {
    const v = m.value;
    switch (m.typeUrl) {
      case "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules": {
        const rules = ((v.rules as Record<string, unknown>[]) ?? []).map((r) => ({
          id: String(r.id ?? ""),
          ...(r.dailyLimit ? { dailyLimit: String(r.dailyLimit) } : {}),
          ...(r.perTxLimit ? { perTxLimit: String(r.perTxLimit) } : {}),
          denoms: (r.allowedDenoms as string[]) ?? [],
          enabled: r.enabled !== false,
        }));
        out.push({ kind: "aa_spending_rules", account: String(v.accountAddress ?? v.owner ?? ""), rules });
        break;
      }
      case "/qorechain.abstractaccount.v1.MsgCreateAbstractAccount":
        out.push({
          kind: "aa_created",
          owner: String(v.owner ?? ""),
          account: String(v.accountAddress ?? v.owner ?? ""),
          ...(v.accountType ? { accountType: String(v.accountType) } : {}),
        });
        break;
      case "/qorechain.pqc.v1.MsgMigratePQCKey":
        out.push({ kind: "pq_key_migrated", address: String(v.sender ?? v.address ?? v.owner ?? "") });
        break;
      case "/qorechain.pqc.v1.MsgRemoveKEMKey":
        out.push({ kind: "kem_key_removed", address: String(v.sender ?? v.address ?? v.owner ?? "") });
        break;
      case "/cosmos.authz.v1beta1.MsgExec":
        out.push({ kind: "authz_exec", grantee: String(v.grantee ?? ""), messages: ((v.msgs as { "@type"?: string }[]) ?? []).map((x) => x["@type"] ?? "?") });
        break;
    }
  }
  return out;
}

/**
 * Enrich typed events with details from the matching message (authz grant
 * authorization and expiry, feegrant allowance, authenticator permissions/label).
 */
export function enrich(events: ChainEvent[], messages: DecodedMsg[]): void {
  for (const ev of events) {
    if (ev.kind === "authz_grant") {
      const m = messages.find((x) => x.typeUrl === "/cosmos.authz.v1beta1.MsgGrant" && x.value.grantee === ev.grantee);
      const g = m?.value.grant as { authorization?: Record<string, unknown>; expiration?: string } | undefined;
      if (g?.authorization) ev.authorization = g.authorization;
      if (g?.expiration) ev.expiration = g.expiration;
    } else if (ev.kind === "feegrant_set") {
      const m = messages.find((x) => x.typeUrl === "/cosmos.feegrant.v1beta1.MsgGrantAllowance" && x.value.grantee === ev.grantee);
      if (m?.value.allowance) ev.allowance = m.value.allowance as Record<string, unknown>;
    } else if (ev.kind === "aa_authenticator_added") {
      const m = messages.find((x) => x.typeUrl === "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator" && x.value.scheme === ev.scheme);
      if (m) {
        if (Array.isArray(m.value.permissions)) ev.permissions = m.value.permissions as string[];
        if (m.value.label) ev.label = String(m.value.label);
      }
    }
  }
}

/** Every qor1 address an event concerns (EVM addresses are converted). */
export function addressesOf(ev: ChainEvent): string[] {
  const raw: (string | undefined)[] = (() => {
    switch (ev.kind) {
      case "transfer":
        return [ev.from, ev.to];
      case "window_opened":
      case "window_closed":
      case "pq_key_registered":
      case "pq_key_rotated":
      case "pq_key_migrated":
      case "kem_key_registered":
      case "kem_key_removed":
      case "classical_only":
        return [ev.address];
      case "window_used":
        return [ev.address];
      case "evm_delegation_consent":
      case "evm_delegation_cleared":
        return [ev.address, ev.delegate];
      case "authz_grant":
      case "authz_revoke":
      case "feegrant_set":
      case "feegrant_revoke":
        return [ev.granter, ev.grantee];
      case "authz_exec":
        return [ev.grantee];
      case "aa_created":
        return [ev.owner, ev.account];
      case "aa_authenticator_added":
      case "aa_authenticator_revoked":
      case "aa_spending_rules":
        return [ev.account];
      case "anomaly":
        return [];
      case "swap":
      case "liquidity":
        return [ev.sender];
      case "delegate":
      case "unbond":
      case "rewards":
      case "tier_lock":
        return [ev.delegator];
      case "redelegate":
        return [ev.delegator];
      case "proposal_submitted":
        return [ev.proposer];
      case "vote":
        return [ev.voter];
      case "deposit":
        return [ev.depositor];
      case "evm_tx":
        return [ev.from, ev.to];
      case "crossvm":
        return [ev.sender, ev.targetContract];
      case "wasm":
        return [ev.sender, ev.contract];
    }
  })();
  const out = new Set<string>();
  for (const r of raw) {
    if (!r) continue;
    if (isEvmAddress(r)) out.add(evmToQor(r));
    else if (isQorAddress(r.toLowerCase())) out.add(r.toLowerCase());
  }
  return [...out];
}
