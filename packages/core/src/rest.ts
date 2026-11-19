import { Http, HttpError } from "./http.js";
import { parseCoins, type Coin } from "./amount.js";

/** The account's post-quantum registration, as QoreChain's PQC module reports it. */
export interface PqcAccount {
  found: boolean;
  algorithm?: string;
  keyType?: string;
  createdAtHeight?: number;
  possessionProven?: boolean;
  /** A key migration in progress (new key waiting to take over). */
  migrating?: boolean;
  /** Where the classical half of the hybrid key comes from (e.g. auth_account). */
  classicalKeySource?: string;
}

/** The account's EVM authorisation window (one per account). */
export interface EvmWindow {
  found: boolean;
  live: boolean;
  openedHeight?: number;
  expiryHeight?: number;
  maxTxs?: number;
  usedTxs?: number;
  maxValueUqor?: bigint;
  usedValueUqor?: bigint;
  remainingBlocks?: number;
  remainingTxs?: number;
  remainingValueUqor?: bigint;
  nativeOnly?: boolean;
  allowedTargets: string[];
}

export interface AuthAccount {
  exists: boolean;
  /** Public key type URL, when the account has signed at least once. */
  pubKeyType?: string;
  /** The classical public key is on chain: it signed before, so a quantum attacker could target it. */
  classicalKeyExposed: boolean;
  sequence: number;
  accountNumber?: number;
  /** Smart (abstract) account or module account types show up here. */
  accountType?: string;
}

export interface AuthzGrant {
  granter: string;
  grantee: string;
  authorization: Record<string, unknown>;
  msgTypeUrl?: string;
  expiration?: string;
}

export interface FeeAllowance {
  granter: string;
  grantee: string;
  allowance: Record<string, unknown>;
}

export interface AbstractAccount {
  address: string;
  accountType: string;
  spendingRulesCount: number;
  sessionKeysCount: number;
  authenticatorsCount: number;
  owner?: string;
}

export interface Pool {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
  status: string;
  poolType: string;
}

export interface Proposal {
  id: string;
  status: string;
  title: string;
  summary: string;
  messages: string[];
  submitTime?: string;
  votingEndTime?: string;
}

export interface Delegation {
  validator: string;
  amount: Coin;
}

export interface Unbonding {
  validator: string;
  completionTime: string;
  balance: bigint;
}

export interface Validator {
  operator: string;
  moniker: string;
  jailed: boolean;
  status: string;
}

/** Read-only REST (LCD) queries QoreWatch uses. */
export class Rest {
  constructor(
    readonly url: string,
    private readonly http = new Http(),
  ) {}

  private get<T>(path: string): Promise<T> {
    return this.http.json<T>(this.url + path);
  }

  /** GET that maps a 404 or a "not found" answer to undefined. */
  private async maybe<T>(path: string): Promise<T | undefined> {
    try {
      return await this.get<T>(path);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return undefined;
      throw e;
    }
  }

  async pqcAccount(address: string): Promise<PqcAccount> {
    const r = await this.maybe<{
      found?: boolean;
      account?: {
        algorithm_name?: string;
        key_type?: string;
        created_at_height?: string;
        possession_proven?: boolean;
        migration_public_key?: string | null;
        classical_key_source?: string;
      };
    }>(`/qorechain/pqc/v1/account/${address}`);
    if (!r?.found || !r.account) return { found: false };
    const a = r.account;
    return {
      found: true,
      ...(a.algorithm_name ? { algorithm: a.algorithm_name } : {}),
      ...(a.key_type ? { keyType: a.key_type } : {}),
      ...(a.created_at_height ? { createdAtHeight: Number(a.created_at_height) } : {}),
      possessionProven: !!a.possession_proven,
      migrating: !!a.migration_public_key,
      ...(a.classical_key_source ? { classicalKeySource: a.classical_key_source } : {}),
    };
  }

  /** The account's ML-KEM key in QoreChain's encryption-key registry. */
  async kemKey(address: string): Promise<{ found: boolean; algorithm?: string }> {
    const r = await this.maybe<{ found?: boolean; key?: { algorithm_name?: string; algorithm_id?: string | number } | null }>(`/qorechain/pqc/v1/kem/${address}`);
    if (!r?.found) return { found: false };
    return { found: true, ...(r.key?.algorithm_name ? { algorithm: r.key.algorithm_name } : {}) };
  }

  async evmWindow(address: string): Promise<EvmWindow> {
    const r = await this.maybe<{
      found?: boolean;
      live?: boolean;
      opened_height?: string;
      expiry_height?: string;
      max_txs?: string;
      used_txs?: string;
      max_value?: string;
      used_value?: string;
      remaining_blocks?: string;
      remaining_txs?: string;
      remaining_value?: string;
      native_only?: boolean;
      allowed_targets?: string[];
    }>(`/qorechain/pqc/v1/evm_window/${address}`);
    if (!r?.found) return { found: false, live: false, allowedTargets: [] };
    const n = (s?: string) => (s === undefined ? undefined : Number(s));
    const b = (s?: string) => (s === undefined ? undefined : BigInt(s));
    const out: EvmWindow = { found: true, live: !!r.live, nativeOnly: !!r.native_only, allowedTargets: (r.allowed_targets ?? []).map((t) => t.toLowerCase()) };
    const set = <K extends keyof EvmWindow>(k: K, v: EvmWindow[K] | undefined) => {
      if (v !== undefined) out[k] = v;
    };
    set("openedHeight", n(r.opened_height));
    set("expiryHeight", n(r.expiry_height));
    set("maxTxs", n(r.max_txs));
    set("usedTxs", n(r.used_txs));
    set("maxValueUqor", b(r.max_value));
    set("usedValueUqor", b(r.used_value));
    set("remainingBlocks", n(r.remaining_blocks));
    set("remainingTxs", n(r.remaining_txs));
    set("remainingValueUqor", b(r.remaining_value));
    return out;
  }

  async authAccount(address: string): Promise<AuthAccount> {
    const r = await this.maybe<{ account?: Record<string, unknown> }>(`/cosmos/auth/v1beta1/accounts/${address}`);
    if (!r?.account) return { exists: false, classicalKeyExposed: false, sequence: 0 };
    // Some account types nest the base account.
    const acc = r.account;
    const base = (acc.base_account as Record<string, unknown> | undefined) ?? acc;
    const pk = base.pub_key as { "@type"?: string } | null | undefined;
    return {
      exists: true,
      ...(pk?.["@type"] ? { pubKeyType: pk["@type"] } : {}),
      classicalKeyExposed: !!pk?.["@type"] && /secp256k1/i.test(pk["@type"]),
      sequence: Number(base.sequence ?? 0),
      ...(base.account_number !== undefined ? { accountNumber: Number(base.account_number) } : {}),
      accountType: String(acc["@type"] ?? ""),
    };
  }

  async balances(address: string): Promise<Coin[]> {
    const r = await this.get<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=200`);
    return r.balances.map((c) => ({ denom: c.denom, amount: BigInt(c.amount) }));
  }

  async grantsByGranter(address: string): Promise<AuthzGrant[]> {
    const r = await this.get<{ grants: { granter: string; grantee: string; authorization: Record<string, unknown>; expiration?: string | null }[] }>(
      `/cosmos/authz/v1beta1/grants/granter/${address}?pagination.limit=200`,
    );
    return r.grants.map((g) => ({
      granter: g.granter,
      grantee: g.grantee,
      authorization: g.authorization,
      ...(typeof g.authorization.msg === "string" ? { msgTypeUrl: g.authorization.msg } : {}),
      ...(g.expiration ? { expiration: g.expiration } : {}),
    }));
  }

  async feeAllowancesIssued(granter: string): Promise<FeeAllowance[]> {
    const r = await this.get<{ allowances: { granter: string; grantee: string; allowance: Record<string, unknown> }[] }>(
      `/cosmos/feegrant/v1beta1/issued/${granter}?pagination.limit=200`,
    );
    return r.allowances;
  }

  async abstractAccount(address: string): Promise<AbstractAccount | undefined> {
    const r = await this.maybe<{
      account?: { address: string; account_type: string; spending_rules_count?: number; session_keys_count?: number; authenticators_count?: number; owner?: string };
    }>(`/qorechain/abstractaccount/v1/accounts/${address}`);
    if (!r?.account) return undefined;
    const a = r.account;
    return {
      address: a.address,
      accountType: a.account_type,
      spendingRulesCount: Number(a.spending_rules_count ?? 0),
      sessionKeysCount: Number(a.session_keys_count ?? 0),
      authenticatorsCount: Number(a.authenticators_count ?? 0),
      ...(a.owner ? { owner: a.owner } : {}),
    };
  }

  async pools(): Promise<Pool[]> {
    const r = await this.get<{ pools: { id: string; token_a: string; token_b: string; reserve_a: string; reserve_b: string; status: string; pool_type: string }[] }>(
      `/qorechain/amm/v1/pools`,
    );
    return r.pools.map((p) => ({
      id: p.id,
      tokenA: p.token_a,
      tokenB: p.token_b,
      reserveA: BigInt(p.reserve_a),
      reserveB: BigInt(p.reserve_b),
      status: p.status,
      poolType: p.pool_type,
    }));
  }

  async proposals(status?: "voting" | "deposit" | "passed" | "rejected", limit = 20): Promise<Proposal[]> {
    const code = { deposit: 1, voting: 2, passed: 3, rejected: 4 } as const;
    const q = `${status ? `proposal_status=${code[status]}&` : ""}pagination.limit=${limit}&pagination.reverse=true`;
    const r = await this.get<{
      proposals: { id: string; status: string; title?: string; summary?: string; messages?: { "@type": string }[]; submit_time?: string; voting_end_time?: string }[];
    }>(`/cosmos/gov/v1/proposals?${q}`);
    return r.proposals.map((p) => ({
      id: p.id,
      status: p.status,
      title: p.title ?? "",
      summary: p.summary ?? "",
      messages: (p.messages ?? []).map((m) => m["@type"]),
      ...(p.submit_time ? { submitTime: p.submit_time } : {}),
      ...(p.voting_end_time ? { votingEndTime: p.voting_end_time } : {}),
    }));
  }

  /** A pending software upgrade plan, if governance scheduled one. */
  async upgradePlan(): Promise<{ name: string; height: number; info: string } | undefined> {
    const r = await this.maybe<{ plan?: { name: string; height: string; info: string } | null }>(`/cosmos/upgrade/v1beta1/current_plan`);
    if (!r?.plan) return undefined;
    return { name: r.plan.name, height: Number(r.plan.height), info: r.plan.info };
  }

  async delegations(address: string): Promise<Delegation[]> {
    const r = await this.get<{ delegation_responses: { delegation: { validator_address: string }; balance: { denom: string; amount: string } }[] }>(
      `/cosmos/staking/v1beta1/delegations/${address}`,
    );
    return r.delegation_responses.map((d) => ({ validator: d.delegation.validator_address, amount: { denom: d.balance.denom, amount: BigInt(d.balance.amount) } }));
  }

  async unbondings(address: string): Promise<Unbonding[]> {
    const r = await this.get<{ unbonding_responses: { validator_address: string; entries: { completion_time: string; balance: string }[] }[] }>(
      `/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`,
    );
    return r.unbonding_responses.flatMap((u) => u.entries.map((e) => ({ validator: u.validator_address, completionTime: e.completion_time, balance: BigInt(e.balance) })));
  }

  /** Total claimable staking rewards, in whole base units (decimals dropped). */
  async rewards(address: string): Promise<Coin[]> {
    const r = await this.get<{ total: { denom: string; amount: string }[] }>(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`);
    return parseCoins(r.total.map((c) => `${c.amount.split(".")[0]}${c.denom}`).join(","));
  }

  async validator(operator: string): Promise<Validator | undefined> {
    const r = await this.maybe<{ validator?: { operator_address: string; jailed: boolean; status: string; description: { moniker: string } } }>(
      `/cosmos/staking/v1beta1/validators/${operator}`,
    );
    if (!r?.validator) return undefined;
    return { operator: r.validator.operator_address, moniker: r.validator.description.moniker, jailed: r.validator.jailed, status: r.validator.status };
  }
}
