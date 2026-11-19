// Records real qorechain-diana transactions as test fixtures, one file per message type.
// Usage: node scripts/record-fixtures.mjs   (reads only; no keys)
import { writeFileSync, mkdirSync } from "node:fs";
const RPC = "https://rpc-testnet.qore.host";
const OUT = new URL("../test/fixtures/tx/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const get = async (path) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC + path, { headers: { "user-agent": "qorewatch-fixtures" } });
    if (r.ok) return (await r.json()).result;
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error("failed " + path);
};
const search = (q, n = 2) => get(`/tx_search?query=${encodeURIComponent(`"${q}"`)}&per_page=${n}&order_by=%22desc%22`);
const TYPES = {
  bank_send: "/cosmos.bank.v1beta1.MsgSend",
  evm_tx: "/cosmos.evm.vm.v1.MsgEthereumTx",
  pqc_register: "/qorechain.pqc.v1.MsgRegisterPQCKey",
  pqc_rotate: "/qorechain.pqc.v1.MsgRotatePQCKey",
  pqc_window_open: "/qorechain.pqc.v1.MsgOpenEVMWindow",
  pqc_window_close: "/qorechain.pqc.v1.MsgCloseEVMWindow",
  pqc_delegation_authorize: "/qorechain.pqc.v1.MsgAuthorizeEVMDelegation",
  pqc_delegation_clear: "/qorechain.pqc.v1.MsgClearEVMDelegation",
  pqc_kem_register: "/qorechain.pqc.v1.MsgRegisterKEMKey",
  authz_grant: "/cosmos.authz.v1beta1.MsgGrant",
  authz_revoke: "/cosmos.authz.v1beta1.MsgRevoke",
  authz_exec: "/cosmos.authz.v1beta1.MsgExec",
  feegrant_grant: "/cosmos.feegrant.v1beta1.MsgGrantAllowance",
  feegrant_revoke: "/cosmos.feegrant.v1beta1.MsgRevokeAllowance",
  aa_create: "/qorechain.abstractaccount.v1.MsgCreateAbstractAccount",
  aa_register_auth: "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator",
  aa_revoke_auth: "/qorechain.abstractaccount.v1.MsgRevokeAuthenticator",
  aa_spending_rules: "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules",
  amm_swap_in: "/qorechain.amm.v1.MsgSwapExactIn",
  amm_add_liquidity: "/qorechain.amm.v1.MsgAddLiquidity",
  staking_delegate: "/cosmos.staking.v1beta1.MsgDelegate",
  staking_undelegate: "/cosmos.staking.v1beta1.MsgUndelegate",
  staking_redelegate: "/cosmos.staking.v1beta1.MsgBeginRedelegate",
  distr_withdraw: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
  gov_submit: "/cosmos.gov.v1.MsgSubmitProposal",
  gov_vote: "/cosmos.gov.v1.MsgVote",
  wasm_execute: "/cosmwasm.wasm.v1.MsgExecuteContract",
  crossvm_call: "/qorechain.crossvm.v1.MsgCrossVMCall",
  stakingtier_lock: "/qorechain.stakingtier.v1.MsgLockDelegation",
};
const index = {};
for (const [name, url] of Object.entries(TYPES)) {
  const r = await search(`message.action='${url}'`, 2);
  const txs = r.txs ?? [];
  for (const t of txs) {
    const b = await get(`/block?height=${t.height}`);
    t.time = b.block.header.time;
  }
  index[name] = { typeUrl: url, total: Number(r.total_count), saved: txs.length };
  if (txs.length) writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(txs, null, 1));
  console.log(name.padEnd(26), r.total_count, txs.length);
}
// Rare events, searched by event rather than message.
for (const [name, q] of Object.entries({
  ev_classical_only: "pqc_hybrid_classical_only.hybrid_mode='required'",
  ev_window_used: "pqc_evm_window_used.source='ante'",
})) {
  const r = await search(q, 2);
  for (const t of r.txs ?? []) t.time = (await get(`/block?height=${t.height}`)).block.header.time;
  if (r.txs?.length) writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(r.txs, null, 1));
  index[name] = { query: q, total: Number(r.total_count), saved: r.txs?.length ?? 0 };
  console.log(name.padEnd(26), r.total_count);
}
writeFileSync(new URL("index.json", OUT), JSON.stringify(index, null, 1));
