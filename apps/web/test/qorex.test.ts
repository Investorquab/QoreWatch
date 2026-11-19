// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import { decodeFunctionData } from "viem";
import { approveZero, ATTEST, attestData, ERC20, txHashOf, WalletError, walletHelp } from "../src/qorex.js";
import { esc, qor, duration } from "../src/ui.js";

describe("QoreX helpers", () => {
  it("reads a transaction hash from QoreX's answer and surfaces chain refusals", () => {
    expect(txHashOf("ABC")).toBe("ABC");
    expect(txHashOf({ code: 0, transactionHash: "DEF" })).toBe("DEF");
    expect(() => txHashOf({ code: 5, rawLog: "insufficient funds" })).toThrowError(/insufficient funds/);
  });

  it("encodes the approval revoke and the attestation calls", () => {
    const r = decodeFunctionData({ abi: ERC20, data: approveZero("0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f") });
    expect(r.functionName).toBe("approve");
    expect([String(r.args[0]).toLowerCase(), r.args[1]]).toEqual(["0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f", 0n]);
    const a = decodeFunctionData({ abi: ATTEST, data: attestData(87, `0x${"ab".repeat(32)}`, "0x4142434432333435") });
    expect(a.args).toEqual([87, `0x${"ab".repeat(32)}`, "0x4142434432333435"]);
  });

  it("encodes a 1 uqor self-send the way the link page sends it", () => {
    const value = MsgSend.encode(MsgSend.fromPartial({ fromAddress: "qor1x", toAddress: "qor1x", amount: [{ denom: "uqor", amount: "1" }] })).finish();
    expect(MsgSend.decode(value)).toMatchObject({ fromAddress: "qor1x", toAddress: "qor1x", amount: [{ denom: "uqor", amount: "1" }] });
  });

  it("gives human help for wallet errors, never echoing markup", () => {
    expect(walletHelp(new WalletError("NOT_INSTALLED", "x"))).toMatch(/Install QoreX/);
    expect(walletHelp(new WalletError("WRONG_NETWORK", "x"))).toMatch(/Switch to testnet/);
    expect(walletHelp(new Error("User rejected the request"))).toMatch(/cancelled/);
    expect(walletHelp(new Error("<img src=x onerror=alert(1)>"))).not.toMatch(/</);
    expect(walletHelp(new Error("insufficient fees"))).toMatch(/faucet/);
  });
});

describe("UI helpers", () => {
  it("escapes everything that reaches the page", () => {
    expect(esc(`<b a="1">'&`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;&amp;");
  });
  it("formats QOR and durations", () => {
    expect(qor("16215443")).toBe("16.215443 QOR");
    expect(qor(1_000_000_000n)).toBe("1,000 QOR");
    expect(duration(600)).toBe("14 min");
  });
});
