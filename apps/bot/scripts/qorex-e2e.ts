/**
 * The web pages with the real QoreX extension (0.4.3) on QoreChain testnet: link, revoke a
 * permission, revoke a fee allowance, revoke a token approval, attest, and close a window
 * by following the fix page's steps inside QoreX itself. The production bot (dist/main.js)
 * runs with a fake Telegram and confirms each result on chain.
 *
 * Needs: a QoreX unpacked extension (QOREX_EXT), a QoreX profile with the alpha account on
 * testnet (QOREX_PROFILE, password QOREX_PASSWORD), QW_KEYS and ATTEST_CONTRACT.
 * Usage: tsx scripts/qorex-e2e.ts
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, closeEvmWindowMsg, deriveUnifiedAccount, msg, openEvmWindowMsg, type UnifiedAccount } from "@qorechain/sdk";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz.js";
import { BasicAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/feegrant.js";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FakeTelegram } from "../test/fake-telegram.js";

const require = createRequire(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/");
const { chromium } = require("playwright") as typeof import("playwright");

const NET = { chainId: "qorechain-diana", rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host", evmRpc: "https://evm-testnet.qore.host" };
const evmChain = defineChain({ id: 9800, name: "QoreChain Testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [NET.evmRpc] } } });
const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const PW = process.env.QOREX_PASSWORD ?? "qorewatch-test-pw-123";
const OUT = process.env.SHOTS ?? tmpdir();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keys = JSON.parse(readFileSync(process.env.QW_KEYS!, "utf8")) as Record<string, { mnemonic: string }>;
const alpha = await deriveUnifiedAccount(keys.alpha!.mnemonic, 0);
const bravo = await deriveUnifiedAccount(keys.bravo!.mnemonic, 0);

async function native(acc: UnifiedAccount, messages: Parameters<EthNativeSigner["signAndBroadcast"]>[1]["messages"]): Promise<void> {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const a = ((await r.json()) as { account: Record<string, string> }).account;
  const t = await StargateClient.connect(NET.rpc);
  try {
    const res = await new EthNativeSigner(acc, { signMode: "hybrid", rest: NET.rest }).signAndBroadcast(t, { chainId: NET.chainId, accountNumber: BigInt(a.account_number!), sequence: BigInt(a.sequence!), fee: { amount: [{ denom: "uqor", amount: "90000" }], gas: "600000" }, messages });
    if (res.code !== 0) throw new Error(res.rawLog ?? `code ${res.code}`);
  } finally {
    t.disconnect();
  }
  await sleep(3000);
}
async function evmTx(acc: UnifiedAccount, to: string, data: Hex) {
  const w = createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain: evmChain, transport: http() });
  const hash = await w.sendTransaction({ to: to as Hex, data, gas: 120_000n });
  await createPublicClient({ chain: evmChain, transport: http() }).waitForTransactionReceipt({ hash });
  await sleep(2000);
}

// ---- bot under test --------------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const root = await tg.start();
const data = mkdtempSync(join(tmpdir(), "qw-qx-"));
const port = 8795;
const base = `http://127.0.0.1:${port}`;
const bot = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, TELEGRAM_BOT_TOKEN: tg.token, TELEGRAM_API_ROOT: root, PUBLIC_URL: base, DATA_DIR: data, HTTP_PORT: String(port), LOG_LEVEL: "warn", POLL_MS: "1200", ATTEST_CONTRACT: process.env.ATTEST_CONTRACT ?? "" },
  stdio: "ignore",
});
const USER = 999;
const say = (t: string) => tg.push(tg.text(USER, t) as never);
const lastUrl = (re: RegExp) => {
  for (const c of [...tg.calls].reverse()) {
    const m = re.exec(JSON.stringify(c.body));
    if (m) return m[0];
  }
  return undefined;
};

// ---- QoreX ---------------------------------------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(process.env.QOREX_PROFILE!, { channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, args: [`--disable-extensions-except=${process.env.QOREX_EXT}`, `--load-extension=${process.env.QOREX_EXT}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const extId = sw.url().split("/")[2];
const unlock = async (pg: import("playwright").Page) => {
  if (await pg.locator("input[type=password]").count()) {
    await pg.locator("input[type=password]").first().fill(PW);
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(5000);
  }
};
const own = new Set<import("playwright").Page>();
const prompts: string[] = [];
// Approve every QoreX prompt that opens (connect, sign, window + send), recording what it showed.
ctx.on("page", async (ap) => {
  await sleep(400);
  if (own.has(ap) || !ap.url().startsWith(`chrome-extension://${extId}`)) return;
  try {
    await ap.waitForLoadState();
    await ap.waitForTimeout(2500);
    await unlock(ap);
    prompts.push((await ap.innerText("body")).replace(/\s+/g, " ").slice(0, 400));
    for (let k = 0; k < 4 && !ap.isClosed(); k++) {
      const b = ap.getByRole("button", { name: /^(approve|connect|sign|tap again|confirm)/i });
      if (!(await b.count())) break;
      await b.first().click();
      await ap.waitForTimeout(2500);
    }
  } catch {
    /* prompt closed itself */
  }
});
const unl = await ctx.newPage();
own.add(unl);
await unl.goto(`chrome-extension://${extId}/popup.html`);
await unl.waitForTimeout(2000);
await unlock(unl);
// Make alpha's first Ethereum account the active one (another test may have left a different one in use).
await unl.getByRole("button", { name: /Your accounts/i }).first().click();
await unl.waitForTimeout(1500);
const use = unl.getByRole("button", { name: "Use Ethereum account", exact: true });
if (await use.count()) {
  await use.click();
  await unl.waitForTimeout(2000);
}
if (!(await unl.innerText("body")).includes(alpha.cosmos.slice(0, 12))) {
  await unl.goto(`chrome-extension://${extId}/popup.html`);
  await unl.waitForTimeout(2000);
}
const active = (await unl.innerText("body")).replace(/\s+/g, " ");
if (!active.includes(alpha.cosmos.slice(0, 12))) throw new Error(`QoreX is not on alpha's account: ${active.slice(0, 160)}`);
await unl.close();

const results: { step: string; pass: boolean; detail?: string }[] = [];
const ONLY = process.env.QX_ONLY ? new RegExp(process.env.QX_ONLY) : undefined;
const wants = (name: string) => !ONLY || ONLY.test(name);
async function step(name: string, fn: () => Promise<string | boolean>) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    const r = await fn();
    results.push({ step: name, pass: r === true || (typeof r === "string" && r.length > 0), ...(typeof r === "string" ? { detail: r.slice(0, 160) } : {}) });
  } catch (e) {
    results.push({ step: name, pass: false, detail: (e as Error).message.slice(0, 200) });
  }
  console.log(`${results.at(-1)!.pass ? "PASS" : "FAIL"} ${name}${results.at(-1)!.pass ? "" : ` — ${results.at(-1)!.detail}`}`);
}
async function onPage(url: string, name: string, act: (p: import("playwright").Page) => Promise<void>, done: RegExp, timeoutMs = 150_000): Promise<string> {
  const p = await ctx.newPage();
  own.add(p);
  await p.goto(url);
  await p.waitForTimeout(2500);
  try {
    await act(p);
    await p.waitForFunction((src) => new RegExp(src).test(document.body.innerText), done.source, { timeout: timeoutMs });
  } catch (e) {
    await p.screenshot({ path: join(OUT, `qx-${name}-failed.png`), fullPage: true }).catch(() => undefined);
    throw e;
  }
  await p.screenshot({ path: join(OUT, `qx-${name}.png`), fullPage: true });
  const t = (await p.innerText("body")).replace(/\s+/g, " ");
  await p.close();
  return t.match(done)?.[0] ?? "ok";
}
const clickConnect = async (p: import("playwright").Page) => {
  await p.getByRole("button", { name: "Connect QoreX" }).click();
  await p.waitForSelector("text=Connected", { timeout: 60_000 });
};

try {
  await sleep(8000);

  await step("link page: connect QoreX, approve the self-send, the bot links the wallet", async () => {
    say("/link");
    await sleep(2500);
    const url = lastUrl(/http:\/\/127\.0\.0\.1:\d+\/link#[A-Z0-9]{8}/)!;
    const r = await onPage(url, "link", async (p) => {
      await clickConnect(p);
      await p.getByRole("button", { name: "Approve in QoreX" }).click();
    }, /You're all set\./);
    const ok = tg.calls.some((c) => /Wallet linked/.test(String(c.body.text ?? "")));
    return ok ? r : "";
  });

  const authz = { typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization", value: GenericAuthorization.encode({ msg: "/cosmos.bank.v1beta1.MsgSend" }).finish() };
  if (wants("fix/authz")) await native(alpha, [msg.authz.grant({ granter: alpha.cosmos, grantee: bravo.cosmos, grant: { authorization: authz, expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 86400), nanos: 0 } } })]);
  await step("fix/authz page: one-tap revoke through QoreX", () =>
    onPage(`${base}/fix/authz#${new URLSearchParams({ granter: alpha.cosmos, grantee: bravo.cosmos, msg: "/cosmos.bank.v1beta1.MsgSend" })}`, "fix-authz", async (p) => {
      await clickConnect(p);
      await p.getByRole("button", { name: "Revoke in QoreX" }).click();
    }, /Revoked\./),
  );

  const allowance = { typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance", value: BasicAllowance.encode({ spendLimit: [{ denom: "uqor", amount: "1000000" }] }).finish() };
  const windowLive = async () => ((await (await fetch(`https://api-testnet.qore.host/qorechain/pqc/v1/evm_window/${alpha.cosmos}`)).json()) as { live?: boolean }).live === true;
  // An allowance left by an earlier, interrupted run is reused: granting twice is refused by the chain.
  const hasAllowance = async () => (await fetch(`https://api-testnet.qore.host/cosmos/feegrant/v1beta1/allowance/${alpha.cosmos}/${bravo.cosmos}`)).ok;
  if (wants("fix/feegrant") && !(await hasAllowance())) await native(alpha, [msg.feegrant.grant({ granter: alpha.cosmos, grantee: bravo.cosmos, allowance })]);
  await step("fix/feegrant page: one-tap revoke through QoreX", () =>
    onPage(`${base}/fix/feegrant#${new URLSearchParams({ granter: alpha.cosmos, grantee: bravo.cosmos })}`, "fix-feegrant", async (p) => {
      await clickConnect(p);
      await p.getByRole("button", { name: "Revoke in QoreX" }).click();
    }, /Revoked\./),
  );

  if (wants("fix/approval")) {
    if (await windowLive()) await native(alpha, [closeEvmWindowMsg(alpha.cosmos)]);
    await native(alpha, [openEvmWindowMsg({ sender: alpha.cosmos, blocks: 300n, maxTxs: 2n, maxValue: 1_000_000n })]);
    await evmTx(alpha, FUSD, encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [bravo.evm as Hex, 2n ** 256n - 1n] }));
    await native(alpha, [closeEvmWindowMsg(alpha.cosmos)]);
  }
  await step("fix/approval page: set the approval to 0 through QoreX (QoreX opens its own window)", () =>
    onPage(`${base}/fix/approval#${new URLSearchParams({ owner: alpha.evm.toLowerCase(), token: FUSD.toLowerCase(), spender: bravo.evm.toLowerCase() })}`, "fix-approval", async (p) => {
      await clickConnect(p);
      await p.getByRole("button", { name: "Revoke in QoreX" }).click();
    }, /Approval removed\./, 180_000),
  );

  if (process.env.ATTEST_CONTRACT) {
    await step("attest page: sign the attestation through QoreX, the bot confirms it matches", async () => {
      say("/attest");
      await sleep(5000);
      const url = lastUrl(/http:\/\/127\.0\.0\.1:\d+\/attest#[A-Z0-9]{8}/)!;
      const r = await onPage(url, "attest", async (p) => {
        await clickConnect(p);
        await p.waitForSelector("text=Report fingerprint", { timeout: 60_000 });
        await p.getByRole("button", { name: "Sign in QoreX" }).click();
      }, /Recorded on QoreChain\./, 200_000);
      return tg.calls.some((c) => /matches the report QoreWatch gave you/.test(String(c.body.text ?? ""))) ? r : "";
    });
  }

  // The window fix is done in QoreX itself: follow the page's three steps literally.
  if (wants("fix/window") && !(await windowLive())) await native(alpha, [openEvmWindowMsg({ sender: alpha.cosmos, blocks: 600n, maxTxs: 3n, maxValue: 1_000_000n })]);
  await step("fix/window page: close the window in QoreX by following the page's steps", async () => {
    const page = await ctx.newPage();
    own.add(page);
    await page.goto(`${base}/fix/window#${alpha.cosmos}`);
    await page.waitForSelector("text=Close the window in QoreX.", { timeout: 30_000 });
    const qx = await ctx.newPage();
    own.add(qx);
    await qx.goto(`chrome-extension://${extId}/popup.html`);
    await qx.waitForTimeout(2500);
    await unlock(qx);
    // Step 2 of the page: the "MetaMask on QoreChain" row that reads "Window open · …".
    await qx.getByRole("button", { name: /MetaMask on QoreChain[\s\S]*Window open/ }).first().click();
    await qx.waitForTimeout(2500);
    await qx.getByRole("button", { name: "Close the window" }).click();
    await qx.waitForSelector("text=Window closed", { timeout: 30_000 });
    for (let k = 0; k < 3; k++) {
      const b = qx.getByRole("button", { name: /^(approve|confirm|sign|tap again)/i });
      if (!(await b.count())) break;
      await b.first().click();
      await qx.waitForTimeout(2500);
    }
    await page.waitForFunction(() => /Window closed\./.test(document.body.innerText), undefined, { timeout: 90_000 });
    await page.screenshot({ path: join(OUT, "qx-fix-window.png"), fullPage: true });
    return "Window closed.";
  });
} catch (e) {
  // A setup transaction or the harness itself failed: that is a failed run, never a silent pass.
  results.push({ step: "harness", pass: false, detail: (e as Error).message.slice(0, 300) });
  console.log(`FAIL harness — ${(e as Error).message.slice(0, 300)}`);
} finally {
  writeFileSync(join(OUT, "qx-prompts.json"), JSON.stringify(prompts, null, 1));
  await ctx.close();
  bot.kill("SIGTERM");
  await tg.stop();
  rmSync(data, { recursive: true, force: true });
  const passed = results.filter((r) => r.pass).length;
  console.log(`\nRESULT ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}
