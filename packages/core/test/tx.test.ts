import { describe, expect, it } from "vitest";
import { buildTx } from "../src/tx.js";
import { fixture, records } from "./helpers.js";

describe("buildTx on real qorechain-diana transactions", () => {
  it("computes the same hash CometBFT reports", async () => {
    const [t] = fixture("bank_send");
    const r = await buildTx({ tx: t!.tx, result: t!.tx_result, height: t!.height, time: t!.time });
    expect(r.hash).toBe(t!.hash);
  });

  it("reads memo, signer, hybrid signature and a transfer from a bank send", async () => {
    const [r] = await records("bank_send");
    expect(r!.memo).toMatch(/^mzk:/);
    expect(r!.signer).toMatch(/^qor1/);
    expect(r!.hybridSigned).toBe(true);
    expect(r!.messages[0]!.typeUrl).toBe("/cosmos.bank.v1beta1.MsgSend");
    expect(r!.events.some((e) => e.kind === "transfer")).toBe(true);
    expect(r!.failed).toBe(false);
  });

  it("parses an EVM window opening with its limits", async () => {
    const rs = await records("own_demo_inbox");
    const open = rs.flatMap((r) => r.events).find((e) => e.kind === "window_opened");
    expect(open).toMatchObject({ kind: "window_opened", address: "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7", maxTxs: 1 });
    if (open?.kind === "window_opened") {
      expect(open.allowedTargets).toEqual(["0xd837298637f4459a3981b540d5543a4423add801"]);
      expect(open.maxValueUqor).toBe(133921n);
    }
  });

  it("parses an EVM transaction inside a window, with its sender and hash", async () => {
    const rs = await records("own_demo_inbox");
    const r = rs.find((x) => x.evmHash)!;
    expect(r.evmHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.signer).toBe("qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7");
    const used = r.events.find((e) => e.kind === "window_used");
    expect(used).toMatchObject({ kind: "window_used", usedTxs: 1 });
    const evm = r.events.find((e) => e.kind === "evm_tx");
    expect(evm).toMatchObject({ kind: "evm_tx", from: "0x35750cc522969f297f421e411e0cb4493572b1a8", to: "0xd837298637f4459a3981b540d5543a4423add801" });
  });

  it("marks reverted EVM transactions as failed with the reason", async () => {
    const rs = await records("evm_failed");
    for (const r of rs) {
      expect(r.failed).toBe(true);
      expect(r.failReason).toMatch(/^EVM: /);
    }
  });

  it("reads post-quantum key events", async () => {
    const reg = (await records("pqc_register")).flatMap((r) => r.events).find((e) => e.kind === "pq_key_registered");
    expect(reg).toMatchObject({ kind: "pq_key_registered", algorithm: "dilithium5" });
    const rot = (await records("pqc_rotate")).flatMap((r) => r.events).find((e) => e.kind === "pq_key_rotated");
    expect(rot).toMatchObject({ kind: "pq_key_rotated", algorithm: "dilithium5" });
  });

  it("reads authz grants with the authorization and expiry from the message", async () => {
    const g = (await records("authz_grant")).flatMap((r) => r.events).find((e) => e.kind === "authz_grant");
    expect(g?.kind).toBe("authz_grant");
    if (g?.kind === "authz_grant") {
      expect(g.granter).toMatch(/^qor1/);
      expect(g.grantee).toMatch(/^qor1/);
      expect(g.msgTypeUrl).toMatch(/^\//);
      expect(g.authorization?.["@type"]).toMatch(/Authorization$/);
    }
    const rv = (await records("authz_revoke")).flatMap((r) => r.events).find((e) => e.kind === "authz_revoke");
    expect(rv?.kind).toBe("authz_revoke");
  });

  it("reads fee grants and their revocation", async () => {
    const s = (await records("feegrant_grant")).flatMap((r) => r.events).find((e) => e.kind === "feegrant_set");
    expect(s?.kind).toBe("feegrant_set");
    if (s?.kind === "feegrant_set") expect(s.allowance?.["@type"]).toMatch(/Allowance$/);
    expect((await records("feegrant_revoke")).flatMap((r) => r.events).some((e) => e.kind === "feegrant_revoke")).toBe(true);
  });

  it("reads smart-account authenticators, spending rules and account creation", async () => {
    const add = (await records("aa_register_auth")).flatMap((r) => r.events).find((e) => e.kind === "aa_authenticator_added");
    expect(add).toMatchObject({ kind: "aa_authenticator_added" });
    if (add?.kind === "aa_authenticator_added") {
      expect(add.expiry).toMatch(/^\d{4}-/);
      expect(add.permissions?.length).toBeGreaterThan(0);
    }
    expect((await records("aa_revoke_auth")).flatMap((r) => r.events).some((e) => e.kind === "aa_authenticator_revoked")).toBe(true);
    const rules = (await records("aa_spending_rules")).flatMap((r) => r.events).find((e) => e.kind === "aa_spending_rules");
    expect(rules).toMatchObject({ kind: "aa_spending_rules" });
    if (rules?.kind === "aa_spending_rules") expect(rules.rules[0]?.denoms).toContain("uqor");
    expect((await records("aa_create")).flatMap((r) => r.events).some((e) => e.kind === "aa_created")).toBe(true);
  });

  it("reads EVM delegation consent and clearing", async () => {
    const c = (await records("pqc_delegation_authorize")).flatMap((r) => r.events).find((e) => e.kind === "evm_delegation_consent");
    expect(c).toMatchObject({ kind: "evm_delegation_consent" });
    if (c?.kind === "evm_delegation_consent") expect(c.delegate).toMatch(/^0x[0-9a-f]{40}$/);
    expect((await records("pqc_delegation_clear")).flatMap((r) => r.events).some((e) => e.kind === "evm_delegation_cleared")).toBe(true);
  });

  it("reads window closes, classical-only signatures and the anomaly check", async () => {
    expect((await records("pqc_window_close")).flatMap((r) => r.events).some((e) => e.kind === "window_closed")).toBe(true);
    const co = await records("ev_classical_only");
    expect(co.every((r) => r.classicalOnly)).toBe(true);
    const an = (await records("bank_send")).flatMap((r) => r.events).find((e) => e.kind === "anomaly");
    expect(an).toMatchObject({ kind: "anomaly", flagged: false });
  });

  it("reads swaps, staking, rewards, tier locks and governance", async () => {
    const swap = (await records("amm_swap_in")).flatMap((r) => r.events).find((e) => e.kind === "swap");
    expect(swap).toMatchObject({ kind: "swap" });
    if (swap?.kind === "swap") expect(swap.amountIn).toBeGreaterThan(0n);
    const ub = (await records("staking_undelegate")).flatMap((r) => r.events).find((e) => e.kind === "unbond");
    expect(ub).toMatchObject({ kind: "unbond" });
    if (ub?.kind === "unbond") expect(ub.completionTime).toMatch(/^\d{4}-/);
    expect((await records("staking_delegate")).flatMap((r) => r.events).some((e) => e.kind === "delegate")).toBe(true);
    expect((await records("staking_redelegate")).flatMap((r) => r.events).some((e) => e.kind === "redelegate")).toBe(true);
    expect((await records("distr_withdraw")).flatMap((r) => r.events).some((e) => e.kind === "rewards")).toBe(true);
    const lock = (await records("stakingtier_lock")).flatMap((r) => r.events).find((e) => e.kind === "tier_lock");
    expect(lock).toMatchObject({ kind: "tier_lock", months: 3 });
    const p = (await records("gov_submit")).flatMap((r) => r.events).find((e) => e.kind === "proposal_submitted");
    expect(p).toMatchObject({ kind: "proposal_submitted", proposalId: "39" });
    const v = (await records("gov_vote")).flatMap((r) => r.events).find((e) => e.kind === "vote");
    expect(v).toMatchObject({ kind: "vote", option: "Yes" });
  });

  it("collects every address a transaction touches", async () => {
    const [r] = await records("authz_grant");
    const g = r!.events.find((e) => e.kind === "authz_grant");
    if (g?.kind === "authz_grant") {
      expect(r!.addresses).toContain(g.granter);
      expect(r!.addresses).toContain(g.grantee);
    }
  });

  it("decodes every recorded message type, except EVM transactions (read from events)", async () => {
    const names = ["bank_send", "pqc_register", "pqc_rotate", "pqc_window_open", "pqc_window_close", "pqc_delegation_authorize", "pqc_delegation_clear", "pqc_kem_register", "authz_grant", "authz_revoke", "authz_exec", "feegrant_grant", "feegrant_revoke", "aa_create", "aa_register_auth", "aa_revoke_auth", "aa_spending_rules", "amm_swap_in", "amm_add_liquidity", "staking_delegate", "staking_undelegate", "staking_redelegate", "distr_withdraw", "gov_submit", "gov_vote", "wasm_execute", "crossvm_call", "stakingtier_lock"];
    for (const n of names) for (const r of await records(n)) for (const m of r.messages) expect(m.decoded, `${n} ${m.typeUrl}`).toBe(true);
  });
});
