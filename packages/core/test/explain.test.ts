import { describe, expect, it } from "vitest";
import { duration, explainEvent, explainTokenLog, explainTx, netFee, plain, visibleEvents } from "../src/explain.js";
import { Tokens } from "../src/tokens.js";
import { records } from "./helpers.js";

const tokens = new Tokens();
tokens.set({ id: "erc20:0x97143b771d34ddb9130b807b135ae675a5a963ca", address: "0x97143b771d34ddb9130b807b135ae675a5a963ca", symbol: "fUSD", decimals: 6 });
const ctx = { tokens, height: 10_386_200 };

describe("explanations", () => {
  it("says what a swap did, without repeating its transfer legs", async () => {
    const [r] = await records("amm_swap_in");
    const e = await explainTx(r!, ctx);
    const text = e.lines.map(plain).join("\n");
    expect(text).toMatch(/swapped 28\.971 QOR for 1\.249856 fUSD in pool 2/);
    expect(text).not.toMatch(/to the AMM/);
  });

  it("calls the watched address 'you'", async () => {
    const rs = await records("own_demo_inbox");
    const r = rs.find((x) => x.events.some((e) => e.kind === "window_opened"))!;
    const e = await explainTx(r, { ...ctx, viewer: "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7" });
    expect(plain(e.lines[0]!)).toMatch(/^you opened an EVM spending window: up to 1 transaction and 0\.133921 QOR \(amounts plus fees\), only to/i);
  });

  it("uses labels the user chose", async () => {
    const [r] = await records("gov_vote");
    const voter = r!.signer!;
    const e = await explainTx(r!, { ...ctx, label: (a) => (a === voter ? "Validator wallet" : undefined) });
    expect(plain(e.lines[0]!)).toBe("Validator wallet voted Yes on proposal #39.");
  });

  it("nets the EVM gas refund out of the fee", async () => {
    const rs = await records("own_demo_inbox");
    const r = rs.find((x) => x.evmHash)!;
    expect(netFee(r)).toBe(58_225_500_000_000_000n - 20_183n * 10n ** 12n);
    expect(visibleEvents(r).some((e) => e.kind === "transfer")).toBe(false);
  });

  it("explains a failed EVM transaction", async () => {
    const [r] = await records("evm_failed");
    const e = await explainTx(r!, ctx);
    expect(plain(e.title)).toMatch(/^Failed: an EVM transaction \(EVM: execution reverted\)/);
  });

  it("explains permission grants with what they allow", async () => {
    const [r] = await records("authz_grant");
    const g = r!.events.find((x) => x.kind === "authz_grant")!;
    expect(plain(await explainEvent(g, ctx))).toMatch(/allowed .* to do a cross-VM call on the account's behalf, any number of times until 2026-/);
  });

  it("explains unlimited token approvals and revocations", async () => {
    const base = { token: "0x97143b771d34ddb9130b807b135ae675a5a963ca", owner: "0x35750cc522969f297f421e411e0cb4493572b1a8", spender: "0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f", txHash: "0x1", block: 1, logIndex: 0 };
    const un = await explainTokenLog({ kind: "token_approval", ...base, value: 2n ** 256n - 1n, unlimited: true }, { ...ctx, viewer: "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7" });
    expect(plain(un)).toMatch(/^You allowed 0x6535…ed8f to spend all of the account's fUSD, now and later\.$/);
    const zero = await explainTokenLog({ kind: "token_approval", ...base, value: 0n, unlimited: false }, ctx);
    expect(plain(zero)).toMatch(/removed .* permission to spend fUSD/);
  });

  it("escapes anything a sender controls", async () => {
    const [r] = await records("bank_send");
    const evil = { ...r!, memo: "<b>hi</b>" };
    const e = await explainTx(evil, ctx);
    expect(e.lines.join("")).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("turns block counts into durations", () => {
    expect(duration(10)).toBe("14 s");
    expect(duration(600)).toBe("14 min");
    expect(duration(17280)).toBe("6 h 49 min");
    expect(duration(200_000)).toBe("3 days");
  });
});
