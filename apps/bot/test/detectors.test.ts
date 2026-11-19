import { describe, expect, it } from "vitest";
import { buildTx, plain, Tokens, type TxRecord, type TokenLog } from "@qorewatch/core";
import type { DetectContext } from "../src/alerts/types.js";
import type { Watch } from "../src/db/store.js";
import { moneyDetector } from "../src/alerts/detectors/money.js";
import { securityDetector } from "../src/alerts/detectors/security.js";
import { activityDetector } from "../src/alerts/detectors/activity.js";
import { stakingDetector } from "../src/alerts/detectors/staking.js";
import { governanceDetector } from "../src/alerts/detectors/governance.js";
import { tokenDetector } from "../src/alerts/detectors/tokens.js";
import { txFixture } from "./fake-chain.js";

const tokens = new Tokens();
tokens.set({ id: "erc20:0x97143b771d34ddb9130b807b135ae675a5a963ca", address: "0x97143b771d34ddb9130b807b135ae675a5a963ca", symbol: "fUSD", decimals: 6 });

const txs = async (name: string): Promise<TxRecord[]> => Promise.all(txFixture(name).map((t) => buildTx({ tx: t.tx, result: t.tx_result as never, height: t.height, time: t.time, hash: t.hash })));

function ctx(address: string, owned = true, label: string | null = null): DetectContext {
  const watch: Watch = { chatId: 1, address, label, owned, linkedTx: null, minUqor: 0n, muted: [], createdAt: "" };
  return { explain: { tokens, ...(owned ? { viewer: address } : {}), height: 10_380_000 }, watch, height: 10_380_000, blockSeconds: 1.42, publicUrl: "https://qw.test", explorer: "https://explore.qore.network" };
}
const text = (a: { title: string; body: string[] }) => plain([a.title, ...a.body].join("\n"));

describe("money detector", () => {
  it("reports tokens received and sent, from both sides of a bank transfer", async () => {
    const [tx] = await txs("bank_send");
    const t = tx!.events.find((e) => e.kind === "transfer" && e.coins[0]?.denom.startsWith("erc20"));
    if (t?.kind !== "transfer") throw new Error("fixture changed");
    const inc = await moneyDetector.detect(tx!, ctx(t.to));
    expect(inc).toHaveLength(1);
    expect(text(inc[0]!)).toMatch(/^💸 Received 2\.4 fUSD\nYou received 2\.4 fUSD from qor1/);
    const out = await moneyDetector.detect(tx!, ctx(t.from, false, "Shop"));
    expect(text(out[0]!)).toMatch(/^📤 Sent 2\.4 fUSD\n2\.4 fUSD left Shop, to qor1/);
    expect(out[0]!.amountUqor).toBeUndefined(); // thresholds apply to QOR only
  });

  it("reports QOR sent through the EVM lane once, to the EVM recipient, without fees or refunds", async () => {
    const rs = await txs("own_demo_inbox");
    const tx = rs.find((r) => r.evmHash)!;
    const a = await moneyDetector.detect(tx, ctx("qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7"));
    expect(a).toHaveLength(1);
    expect(text(a[0]!)).toMatch(/^📤 Sent 0\.011 QOR\n0\.011 QOR left your account, to 0xd837…d801\./);
    expect(a[0]!.amountUqor).toBe(11_000n);
  });

  it("stays quiet for swaps (the activity detector covers them) and failed transactions", async () => {
    const [swap] = await txs("amm_swap_in");
    const sender = swap!.events.find((e) => e.kind === "swap");
    if (sender?.kind !== "swap") throw new Error("fixture changed");
    expect(await moneyDetector.detect(swap!, ctx(sender.sender))).toEqual([]);
    const [failed] = await txs("evm_failed");
    expect(await moneyDetector.detect(failed!, ctx(failed!.signer!))).toEqual([]);
  });
});

describe("security detector", () => {
  it("warns about a key rotation as critical and asks if it was you", async () => {
    const [tx] = await txs("pqc_rotate");
    const a = await securityDetector.detect(tx!, ctx(tx!.signer!));
    const rot = a.find((x) => x.key.endsWith("pqrot"))!;
    expect(rot.level).toBe("critical");
    expect(text(rot)).toMatch(/post-quantum key of your account changed\. Was this you\?/);
    expect(text(rot)).toMatch(/move your funds to a new wallet now/);
  });

  it("describes a window opened to one contract, with a close button", async () => {
    const rs = await txs("own_demo_inbox");
    const tx = rs.find((r) => r.events.some((e) => e.kind === "window_opened"))!;
    const a = await securityDetector.detect(tx, ctx("qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7"));
    const w = a.find((x) => x.key.includes(":win"))!;
    expect(w.level).toBe("info");
    expect(text(w)).toMatch(/1 transaction worth up to 0\.133921 QOR can be sent to the allowed contract only/);
    expect(w.buttons!.flat().find((b) => b.text.includes("Close"))?.url).toBe("https://qw.test/fix/window#qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7");
  });

  it("warns when someone is given permission over the account, with a revoke link", async () => {
    const [tx] = await txs("authz_grant");
    const g = tx!.events.find((e) => e.kind === "authz_grant");
    if (g?.kind !== "authz_grant") throw new Error("fixture changed");
    const a = await securityDetector.detect(tx!, ctx(g.granter));
    expect(a[0]!.level).toBe("warning");
    expect(text(a[0]!)).toMatch(/Someone can now act for your account/);
    const url = a[0]!.buttons!.flat().find((b) => b.text.includes("Revoke"))!.url!;
    expect(url).toContain("https://qw.test/fix/authz#");
    expect(new URLSearchParams(url.split("#")[1]).get("grantee")).toBe(g.grantee);
    const asGrantee = await securityDetector.detect(tx!, ctx(g.grantee));
    expect(asGrantee[0]!.level).toBe("info");
  });

  it("covers fee grants, session keys, spending rules, delegations, classical-only signatures and revocations", async () => {
    const check = async (name: string, pick: (r: TxRecord) => string, expectTitle: RegExp, level?: string) => {
      const [tx] = await txs(name);
      const a = await securityDetector.detect(tx!, ctx(pick(tx!)));
      const hit = a.find((x) => expectTitle.test(plain(x.title)));
      expect(hit, `${name}: ${a.map((x) => plain(x.title)).join(" | ")}`).toBeDefined();
      if (level) expect(hit!.level).toBe(level);
    };
    const granter = (r: TxRecord) => (r.events.find((e) => e.kind === "feegrant_set" || e.kind === "feegrant_revoke") as { granter: string }).granter;
    await check("feegrant_grant", granter, /spend your account's QOR on fees/, "warning");
    await check("feegrant_revoke", granter, /Fee allowance revoked/, "info");
    await check("aa_register_auth", (r) => r.signer!, /A session key can now sign/, "warning");
    await check("aa_revoke_auth", (r) => r.signer!, /Session key removed/);
    await check("aa_spending_rules", (r) => r.signer!, /spending rules changed/);
    await check("aa_create", (r) => r.signer!, /smart account/);
    await check("pqc_delegation_authorize", (r) => r.signer!, /Another address can now act/, "warning");
    await check("pqc_delegation_clear", (r) => r.signer!, /EVM delegation withdrawn/);
    await check("pqc_window_close", (r) => r.signer!, /Spending window closed/);
    // A key registration is classical-only by necessity: no warning for that bootstrap…
    const [reg] = await txs("ev_classical_only");
    const regAlerts = await securityDetector.detect(reg!, ctx(reg!.signer!));
    expect(regAlerts.some((x) => /classical-only/.test(plain(x.title)))).toBe(false);
    expect(regAlerts.some((x) => /Post-quantum key registered/.test(plain(x.title)))).toBe(true);
    // …but any other classical-only transaction is a warning.
    const bare = { ...reg!, events: reg!.events.filter((e) => e.kind !== "pq_key_registered") };
    const warn = await securityDetector.detect(bare, ctx(reg!.signer!));
    expect(warn.find((x) => /classical-only signature/.test(plain(x.title)))?.level).toBe("warning");
    await check("pqc_register", (r) => r.signer!, /Post-quantum key registered/);
    await check("pqc_kem_register", (r) => r.signer!, /Encryption key/);
    await check("ev_window_used", (r) => r.signer!, /Spent from the open window/);
  });
});

describe("activity, staking and governance detectors", () => {
  it("flags a failed transaction from the account", async () => {
    const [tx] = await txs("evm_failed");
    const a = await activityDetector.detect(tx!, ctx(tx!.signer!));
    expect(a[0]!.level).toBe("warning");
    expect(text(a[0]!)).toMatch(/A transaction from your account failed\nEVM: execution reverted/);
  });

  it("reports swaps by the account", async () => {
    const [tx] = await txs("amm_swap_in");
    const s = tx!.events.find((e) => e.kind === "swap") as { sender: string };
    const a = await activityDetector.detect(tx!, ctx(s.sender));
    expect(text(a[0]!)).toMatch(/Swap\nYou swapped 28\.971 QOR for 1\.249856 fUSD in pool 2/);
  });

  it("reports staking moves and skips empty reward claims", async () => {
    const [ub] = await txs("staking_undelegate");
    const a = await stakingDetector.detect(ub!, ctx(ub!.signer!));
    expect(a.some((x) => /Unstaking started/.test(plain(x.title)))).toBe(true);
    const [wd] = await txs("distr_withdraw");
    const b = await stakingDetector.detect(wd!, ctx(wd!.signer!));
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThanOrEqual(4);
    expect(b.every((x) => !/claimed 0 QOR/.test(plain(x.body.join(" "))))).toBe(true);
  });

  it("confirms the account's votes", async () => {
    const [tx] = await txs("gov_vote");
    const a = await governanceDetector.detect(tx!, ctx(tx!.signer!));
    expect(text(a[0]!)).toMatch(/Vote recorded\nYou voted Yes on proposal #39/);
  });
});

describe("token detector (EVM logs)", () => {
  const evm = "0x35750cc522969f297f421e411e0cb4493572b1a8";
  const qor = "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7";
  const base = { token: "0x97143b771d34ddb9130b807b135ae675a5a963ca", txHash: "0xabc", block: 10, logIndex: 1 };

  it("warns about an unlimited approval with a revoke link", async () => {
    const log: TokenLog = { kind: "token_approval", ...base, owner: evm, spender: "0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f", value: 2n ** 256n - 1n, unlimited: true };
    const [a] = await tokenDetector.detect(log, ctx(qor));
    expect(a!.level).toBe("warning");
    expect(text(a!)).toMatch(/Unlimited token approval on your account\nYou allowed 0x6535…ed8f to spend all of the account's fUSD/);
    expect(a!.buttons!.flat().find((b) => b.text.includes("Revoke"))!.url).toBe(`https://qw.test/fix/approval#owner=${evm}&token=${base.token}&spender=0x65353cd68f5f0e3e6fd3c578f1215e36da25ed8f`);
  });

  it("reports tokens received and minted", async () => {
    const [a] = await tokenDetector.detect({ kind: "token_transfer", ...base, from: "0xeb279977041a05a7f909bd0942411f682bb581d8", to: evm, value: 5_000_000n }, ctx(qor));
    expect(text(a!)).toMatch(/^💸 Received 5 fUSD\n0xeb27…81d8 sent 5 fUSD to your account\./);
    const [m] = await tokenDetector.detect({ kind: "token_transfer", ...base, from: "0x0000000000000000000000000000000000000000", to: evm, value: 1_000_000n }, ctx(qor));
    expect(text(m!)).toMatch(/1 fUSD was minted to your account/);
  });

  it("ignores logs that do not concern the account", async () => {
    expect(await tokenDetector.detect({ kind: "token_transfer", ...base, from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", value: 1n }, ctx(qor))).toEqual([]);
  });
});
