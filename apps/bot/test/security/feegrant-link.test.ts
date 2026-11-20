import { describe, expect, it } from "vitest";
import { buildTx } from "@qorewatch/core";
import { TxRaw, AuthInfo, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Store } from "../../src/db/store.js";
import { handleLinkTx, LINK_MEMO } from "../../src/linking.js";
import type { Messenger } from "../../src/telegram/messenger.js";
import { txFixture } from "../fake-chain.js";

type Ev = { type: string; attributes: { key: string; value: string; index?: boolean }[] };

/**
 * Audit A1 / F-8: in Cosmos SDK the ante handler's `tx` event names the account the fee was
 * DEDUCTED FROM as `fee_payer`. When a fee grant is used, that is the granter, not the signer.
 * An attacker who holds a fee allowance from a victim signs their own hybrid-signed link
 * transaction, sets the victim as fee granter, and gets the victim's address linked as "owned".
 */
async function feeGrantedLinkTx(victim: string, code: string) {
  const t = txFixture("bank_send")[0]!;
  const raw = TxRaw.decode(Buffer.from(t.tx, "base64"));
  const body = TxBody.decode(raw.bodyBytes);
  body.memo = LINK_MEMO(code);
  raw.bodyBytes = TxBody.encode(body).finish();
  const auth = AuthInfo.decode(raw.authInfoBytes);
  auth.fee!.granter = victim;
  raw.authInfoBytes = AuthInfo.encode(auth).finish();
  const result = JSON.parse(JSON.stringify(t.tx_result)) as { events: Ev[] };
  const real = (await buildTx({ tx: t.tx, result: t.tx_result as never, height: t.height, time: t.time, hash: t.hash })).signer!;
  // What the SDK emits with a fee grant: DeductFeeDecorator's event names the granter; the signer
  // still appears in acc_seq (SetPubKeyDecorator) and in pqc_hybrid_verify.
  for (const e of result.events) {
    if (e.type === "tx") for (const a of e.attributes) if (a.key === "fee_payer") a.value = victim;
    if (e.type === "coin_spent" && e.attributes.some((a) => a.value === real)) for (const a of e.attributes) if (a.key === "spender") a.value = victim;
  }
  if (!result.events.some((e) => e.type === "tx" && e.attributes.some((a) => a.key === "acc_seq"))) result.events.push({ type: "tx", attributes: [{ key: "acc_seq", value: `${real}/7` }] });
  result.events.push({ type: "use_feegrant", attributes: [{ key: "granter", value: victim }, { key: "grantee", value: real }] });
  const tx = await buildTx({ tx: Buffer.from(TxRaw.encode(raw).finish()).toString("base64"), result: result as never, height: t.height, time: t.time, hash: "F".repeat(64) });
  return { tx, attacker: real };
}

describe("security: link signer cannot be spoofed with a fee grant", () => {
  it("never treats the fee granter as the signer of a link transaction", async () => {
    const VICTIM = "qor1kkkytv23u0aagmyp5m6h27r9wlxan0hj5q7w5c";
    const store = new Store(":memory:");
    const ATTACKER_CHAT = 666;
    store.ensureChat(ATTACKER_CHAT, "private");
    const code = store.createCode(ATTACKER_CHAT, "link");
    // The claim endpoint takes any address string: the attacker claims the victim's.
    expect(store.claimCode(code, VICTIM)).toBe("claimed");
    const { tx, attacker } = await feeGrantedLinkTx(VICTIM, code);
    expect(attacker).not.toBe(VICTIM);
    expect(tx.hybridSigned).toBe(true);
    // The signer is the account whose key signed, never the account that paid the fee.
    expect(tx.signer).toBe(attacker);
    const sent: string[] = [];
    const m: Messenger = { send: async (_c, html) => (sent.push(html), { ok: true }) };
    const out = await handleLinkTx(tx, store, m, "https://qorewatch.test");
    expect(out.linked).toBe(false);
    expect(store.watch(ATTACKER_CHAT, VICTIM)?.owned).not.toBe(true);
    store.close();
  });
});
