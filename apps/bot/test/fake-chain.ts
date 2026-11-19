import { readFileSync } from "node:fs";
import { chainConfig, Handles, Http, Rest, Rpc, Tokens, type Evm, type FetchLike } from "@qorewatch/core";
import type { Chain } from "../src/chain.js";

export const ME = "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7";
export const CAROL = "qor1avnejacyrgz607gfh5y5ysgldq4mtqwcy67tzp";
export const GRANTEE = "qor1kkkytv23u0aagmyp5m6h27r9wlxan0hj5q7w5c";

const fixtures = new URL("../../../packages/core/test/fixtures/", import.meta.url);
export const txFixture = (name: string) => JSON.parse(readFileSync(new URL(`tx/${name}.json`, fixtures), "utf8")) as { hash: string; height: string; index: number; tx: string; time: string; tx_result: unknown }[];
const handleFixture = JSON.parse(readFileSync(new URL("handle-test.json", fixtures), "utf8")) as { record: { handle: string; qorAddress: string } };

/**
 * A fake QoreChain node: REST and RPC paths answered from data recorded on testnet.
 * Tests change `state` to put an account in a given situation.
 */
export function fakeChain(state: FakeState = defaultState()): { chain: Chain; state: FakeState; requests: string[] } {
  const requests: string[] = [];
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    const u = new URL(url);
    const p = u.pathname;
    const addr = p.split("/").pop()!;
    if (u.host === "rest") {
      if (p.startsWith("/qorechain/pqc/v1/account/")) return json(200, state.pqc[addr] ? { found: true, account: { algorithm_name: "dilithium5", key_type: "hybrid", created_at_height: "10346283", possession_proven: true, migration_public_key: null } } : { found: false });
      if (p.startsWith("/qorechain/pqc/v1/evm_window/")) return json(200, state.window[addr] ?? { found: false });
      if (p.startsWith("/qorechain/pqc/v1/kem/")) return json(200, { found: false, key: null });
      if (p.startsWith("/cosmos/auth/v1beta1/accounts/")) return state.auth[addr] ? json(200, { account: { "@type": "/cosmos.auth.v1beta1.BaseAccount", pub_key: { "@type": "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey", key: "x" }, sequence: String(state.auth[addr]), account_number: "1" } }) : json(404, { code: 5 });
      if (p.startsWith("/cosmos/bank/v1beta1/balances/")) return json(200, { balances: state.balances[addr] ?? [] });
      if (p.startsWith("/cosmos/authz/v1beta1/grants/granter/")) return json(200, { grants: state.grants[addr] ?? [] });
      if (p.startsWith("/cosmos/feegrant/v1beta1/issued/")) return json(200, { allowances: [] });
      if (p.startsWith("/qorechain/abstractaccount/v1/accounts/")) return json(404, {});
      if (p === "/qorechain/amm/v1/pools") return json(200, { pools: state.pools });
      if (p === "/cosmos/gov/v1/proposals") return json(200, { proposals: state.proposals });
      if (p === "/cosmos/upgrade/v1beta1/current_plan") return json(200, { plan: state.upgrade ?? null });
      return json(404, {});
    }
    if (u.host === "rpc") {
      if (p === "/status") return json(200, { result: { node_info: { network: "qorechain-diana" }, sync_info: { latest_block_height: String(state.height), latest_block_time: "2026-11-19T18:00:00Z", catching_up: false } } });
      if (p === "/tx") {
        const h = (u.searchParams.get("hash") ?? "").replace(/^0x/, "").toUpperCase();
        const t = state.txs.find((x) => x.hash === h);
        return t ? json(200, { result: t }) : json(200, { error: { code: -32603, message: "Internal error", data: `tx (${h}) not found` } });
      }
      if (p === "/block") return json(200, { result: { block: { header: { time: "2026-11-19T18:00:00Z", height: u.searchParams.get("height") }, data: { txs: [] } } } });
      if (p === "/tx_search") {
        const q = u.searchParams.get("query") ?? "";
        const hits = state.txs.filter((t) => JSON.stringify(t.tx_result).includes(q.match(/'([^']+)'/)?.[1] ?? "@@"));
        return json(200, { result: { total_count: String(hits.length), txs: hits } });
      }
    }
    if (u.host === "registry") {
      const h = p.split("/").pop();
      if (p.startsWith("/resolve/") && h === "test") return json(200, handleFixture);
      if (p.startsWith("/reverse/") && h === handleFixture.record.qorAddress) return json(200, handleFixture);
      return json(404, {});
    }
    return json(404, {});
  };
  const http = new Http({ fetch, attempts: 1 });
  const tokens = new Tokens();
  tokens.set({ id: "erc20:0x97143b771d34ddb9130b807b135ae675a5a963ca", address: "0x97143b771d34ddb9130b807b135ae675a5a963ca", symbol: "fUSD", decimals: 6 });
  const evm = {
    isContract: async (a: string) => state.contracts.includes(a.toLowerCase()),
    allowance: async () => state.allowance,
    riskScore: async () => undefined,
  } as unknown as Evm;
  const chain: Chain = { cfg: chainConfig("testnet", { rpc: "https://rpc", rest: "https://rest" }), rpc: new Rpc("https://rpc", http), rest: new Rest("https://rest", http), evm, tokens, handles: new Handles(http, "https://registry") };
  return { chain, state, requests };
}

export interface FakeState {
  height: number;
  pqc: Record<string, boolean>;
  auth: Record<string, number>;
  window: Record<string, unknown>;
  balances: Record<string, { denom: string; amount: string }[]>;
  grants: Record<string, unknown[]>;
  pools: unknown[];
  proposals: unknown[];
  upgrade?: { name: string; height: string; info: string };
  txs: { hash: string; height: string; index: number; tx: string; time: string; tx_result: unknown }[];
  contracts: string[];
  allowance: bigint;
}

export function defaultState(): FakeState {
  return {
    height: 10_386_500,
    pqc: { [ME]: true },
    auth: { [ME]: 50, [CAROL]: 12 },
    window: {},
    balances: { [ME]: [{ denom: "uqor", amount: "4625779" }, { denom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", amount: "12000000" }] },
    grants: {},
    pools: [{ id: "2", token_a: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", token_b: "uqor", reserve_a: "458025638", reserve_b: "10409714827", status: "active", pool_type: "constant_product" }],
    proposals: [],
    txs: [...txFixture("own_demo_inbox"), ...txFixture("authz_grant"), ...txFixture("bank_send")],
    contracts: ["0xd837298637f4459a3981b540d5543a4423add801"],
    allowance: 0n,
  };
}
