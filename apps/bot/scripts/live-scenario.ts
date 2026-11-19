/**
 * Live scenario on QoreChain testnet: the production bundle (dist/main.js) watches while
 * two test accounts do everything a real user and a stranger would: link, send, open and
 * spend from a window, grant and revoke permissions and fee allowances, approve and revoke
 * tokens, stake and unstake, fail a transaction, attest, close the window, and register a
 * brand-new account's post-quantum key. Every alert is checked as it arrives.
 *
 * Telegram is a local fake (no token needed). Keys come from QW_KEYS (a JSON file with
 * testnet-only mnemonics for alpha, bravo and fresh) and are never printed.
 * Usage: pnpm --filter @qorewatch/bot build && QW_KEYS=/path/keys.json ATTEST_CONTRACT=0x… tsx scripts/live-scenario.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  authorizeEvmDelegationMsg,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  msg,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz.js";
import { BasicAllowance } from "cosmjs-types/cosmos/feegrant/v1beta1/feegrant.js";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FakeTelegram } from "../test/fake-telegram.js";

const NET = { chainId: "qorechain-diana", rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host", evmRpc: "https://evm-testnet.qore.host" };
const evmChain = defineChain({ id: 9800, name: "QoreChain Testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [NET.evmRpc] } } });
const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const ATTEST = (process.env.ATTEST_CONTRACT ?? "").toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keys = JSON.parse(readFileSync(process.env.QW_KEYS!, "utf8")) as Record<"alpha" | "bravo" | "fresh", { mnemonic: string }>;
const alpha = await deriveUnifiedAccount(keys.alpha.mnemonic, 0);
const bravo = await deriveUnifiedAccount(keys.bravo.mnemonic, 0);
const fresh = await deriveUnifiedAccount(keys.fresh.mnemonic, 0);

// ---- chain actions ---------------------------------------------------------------------------------------------
async function seq(address: string) {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  const b = (await r.json()) as { account?: Record<string, unknown> };
  const acc = (b.account?.base_account ?? b.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}
type Msgs = Parameters<EthNativeSigner["signAndBroadcast"]>[1]["messages"];
async function native(acc: UnifiedAccount, messages: Msgs, memo = "", mode: "hybrid" | "classical" = "hybrid", gas = 600_000): Promise<string> {
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: NET.rest });
  const transport = await StargateClient.connect(NET.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, { chainId: NET.chainId, ...(await seq(acc.cosmos)), fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.15)) }], gas: String(gas) }, messages, memo });
    if (res.code !== 0) throw new Error(`native tx refused (code ${res.code}): ${res.rawLog ?? ""}`);
    await sleep(3000);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}
async function ensureKey(acc: UnifiedAccount) {
  if ((await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos })).registered) return false;
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  await native(acc, [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession })], "", "classical", 800_000);
  return true;
}
const publicClient = createPublicClient({ chain: evmChain, transport: http() });
async function evm(acc: UnifiedAccount, tx: { to: string; data?: Hex; value?: bigint; gas?: bigint }): Promise<{ hash: string; status: string }> {
  const w = createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain: evmChain, transport: http() });
  const hash = await w.sendTransaction({ to: tx.to as Hex, data: tx.data ?? "0x", value: tx.value ?? 0n, gas: tx.gas ?? 120_000n });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  await sleep(2000);
  return { hash, status: r.status };
}
const ERC20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const ATTEST_ABI = parseAbi(["function attest(uint16 score, bytes32 reportHash, bytes8 code)"]);

// ---- the bot under test ------------------------------------------------------------------------------------------
const tg = new FakeTelegram();
const root = await tg.start();
const data = mkdtempSync(join(tmpdir(), "qw-scn-"));
const port = 8796;
const bot = spawn(process.execPath, ["dist/main.js"], {
  env: { ...process.env, TELEGRAM_BOT_TOKEN: tg.token, TELEGRAM_API_ROOT: root, PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: data, HTTP_PORT: String(port), LOG_LEVEL: "info", POLL_MS: "1200", ATTEST_CONTRACT: ATTEST },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs: string[] = [];
bot.stdout.on("data", (d) => logs.push(...String(d).trim().split("\n")));
bot.stderr.on("data", (d) => logs.push(...String(d).trim().split("\n")));
const USER = 777;
const msgs = () => tg.calls.filter((c) => (c.method === "sendMessage" || c.method === "sendPhoto") && Number(c.body.chat_id) === USER).map((c) => String(c.body.text ?? c.body.caption ?? ""));
const say = (t: string) => tg.push(tg.text(USER, t) as never);

const results: { step: string; pass: boolean; detail: string }[] = [];
async function expectMsg(step: string, re: RegExp, from: number, timeoutMs = 90_000): Promise<string | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = msgs().slice(from).find((m) => re.test(m));
    if (hit) {
      results.push({ step, pass: true, detail: hit.replace(/\n/g, " ⏎ ").slice(0, 170) });
      console.log(`PASS ${step}`);
      return hit;
    }
    await sleep(1000);
  }
  results.push({ step, pass: false, detail: msgs().slice(from).map((m) => m.split("\n")[0]).join(" | ").slice(0, 300) });
  console.log(`FAIL ${step}`);
  return undefined;
}
async function act(step: string, fn: () => Promise<unknown>, re: RegExp, timeoutMs?: number) {
  const from = msgs().length;
  try {
    await fn();
  } catch (e) {
    results.push({ step, pass: false, detail: `action failed: ${(e as Error).message.slice(0, 200)}` });
    console.log(`FAIL ${step}: ${(e as Error).message.slice(0, 160)}`);
    return;
  }
  await expectMsg(step, re, from, timeoutMs);
}

try {
  await sleep(8000);
  if (!/"ok":true/.test(JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()))) throw new Error("bot not healthy");
  console.log("bot healthy; preparing accounts");
  await ensureKey(bravo);

  // 1. Link alpha with a hybrid-signed self-send carrying the code.
  let from = msgs().length;
  say("/link");
  const linkMsg = await expectMsg("/link gives a one-time code", /QoreWatch link ([A-Z0-9]{8})/, from, 20_000);
  const code = /QoreWatch link ([A-HJ-NP-Z2-9]{8})/.exec(linkMsg ?? "")?.[1];
  await act("link: hybrid-signed self-send carrying the code links the wallet", () => native(alpha, [msg.bank.send({ fromAddress: alpha.cosmos, toAddress: alpha.cosmos, amount: [{ denom: "uqor", amount: "1" }] })], `QoreWatch link ${code}`), /Wallet linked/);
  from = msgs().length;
  say(`/watch ${bravo.cosmos} Bravo`);
  await expectMsg("watch bravo read-only", /Watching/, from, 20_000);
  from = msgs().length;
  say(`/watch ${fresh.cosmos} Fresh`);
  await expectMsg("watch fresh read-only", /Watching/, from, 20_000);

  // 2. Money on the native lane.
  await act("money in: bravo sends alpha 0.5 QOR", () => native(bravo, [msg.bank.send({ fromAddress: bravo.cosmos, toAddress: alpha.cosmos, amount: [{ denom: "uqor", amount: "500000" }] })], "lunch money"), /Received 0\.5 QOR[\s\S]*from <b>Bravo<\/b>/);
  await act("money out: alpha sends bravo 0.25 QOR", () => native(alpha, [msg.bank.send({ fromAddress: alpha.cosmos, toAddress: bravo.cosmos, amount: [{ denom: "uqor", amount: "250000" }] })]), /Sent 0\.25 QOR/);

  // 3. A window open to any recipient, and spending inside it.
  await act("window opened to any recipient", () => native(alpha, [openEvmWindowMsg({ sender: alpha.cosmos, blocks: 3000n, maxTxs: 10n, maxValue: 3_000_000n })]), /spending window opened on your account, to any recipient/);
  await act("EVM value transfer inside the window", () => evm(alpha, { to: bravo.evm, value: parseEther("0.01") }), /Spent from the open window|Sent 0\.01 QOR/);
  await act("unlimited fUSD approval", () => evm(alpha, { to: FUSD, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [bravo.evm as Hex, 2n ** 256n - 1n] }) }), /Unlimited token approval/);
  await act("approval revoked", () => evm(alpha, { to: FUSD, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [bravo.evm as Hex, 0n] }) }), /Token permission removed/);
  await act("failed transaction from the account", () => evm(alpha, { to: ATTEST, data: encodeFunctionData({ abi: ATTEST_ABI, functionName: "attest", args: [101, `0x${"11".repeat(32)}`, "0x0000000000000000"] }), gas: 200_000n }), /transaction from your account failed/);

  // 4. Attest: ask the bot for the report, sign it from alpha.
  from = msgs().length;
  say("/attest");
  const att = await expectMsg("/attest gives a page", /Attest your account check/, from, 30_000);
  const attCode = /attest#([A-Z0-9]{8})/.exec(JSON.stringify(tg.calls.at(-1)?.body ?? {}))?.[1] ?? /attest#([A-Z0-9]{8})/.exec(JSON.stringify(tg.calls.filter((c) => c.method === "sendMessage").map((c) => c.body)))?.[1];
  if (att && attCode) {
    const rep = (await (await fetch(`http://127.0.0.1:${port}/api/attest/${attCode}/report?account=${alpha.cosmos}`)).json()) as { score: number; reportHash: Hex; code: Hex };
    await act("attestation recorded and matches the issued report", () => evm(alpha, { to: ATTEST, data: encodeFunctionData({ abi: ATTEST_ABI, functionName: "attest", args: [rep.score, rep.reportHash, rep.code] }) }), /Attestation recorded[\s\S]*matches the report/, 120_000);
  } else results.push({ step: "attestation recorded", pass: false, detail: "no attest code" });

  // 5. Permissions: authz and fee grants, given and taken back.
  const exp = new Date(Date.now() + 86400_000);
  const authz = { typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization", value: GenericAuthorization.encode({ msg: "/cosmos.bank.v1beta1.MsgSend" }).finish() };
  await act("authz grant warns with a revoke link", () => native(alpha, [msg.authz.grant({ granter: alpha.cosmos, grantee: bravo.cosmos, grant: { authorization: authz, expiration: { seconds: BigInt(Math.floor(exp.getTime() / 1000)), nanos: 0 } } })]), /Someone can now act for your account/);
  await act("authz revoke confirmed", () => native(alpha, [msg.authz.revoke({ granter: alpha.cosmos, grantee: bravo.cosmos, msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend" })]), /Permission revoked/);
  const allowance = { typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance", value: BasicAllowance.encode({ spendLimit: [{ denom: "uqor", amount: "1000000" }] }).finish() };
  await act("fee grant warns", () => native(alpha, [msg.feegrant.grant({ granter: alpha.cosmos, grantee: bravo.cosmos, allowance })]), /spend your account's QOR on fees/);
  await act("fee grant revoke confirmed", () => native(alpha, [msg.feegrant.revoke({ granter: alpha.cosmos, grantee: bravo.cosmos })]), /Fee allowance revoked/);
  await act("EVM delegation consent warns", () => native(alpha, [authorizeEvmDelegationMsg({ sender: alpha.cosmos, delegate: bravo.evm, blocks: 200 })]), /Another address can now act for your account/);

  // 6. Staking.
  const vals = (await (await fetch(`${NET.rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=5`)).json()) as { validators: { operator_address: string }[] };
  const val = vals.validators[0]!.operator_address;
  await act("staked", () => native(alpha, [msg.staking.delegate({ delegatorAddress: alpha.cosmos, validatorAddress: val, amount: { denom: "uqor", amount: "200000" } })]), /Staked/);
  await act("unstaking started", () => native(alpha, [msg.staking.undelegate({ delegatorAddress: alpha.cosmos, validatorAddress: val, amount: { denom: "uqor", amount: "100000" } })]), /Unstaking started/);

  // 7. Close the window.
  await act("window closed", () => native(alpha, [closeEvmWindowMsg(alpha.cosmos)]), /Spending window closed/);

  // 8. A brand-new account: at risk, then its key registration (no classical-only false alarm), then ready.
  from = msgs().length;
  say(`/check ${fresh.cosmos}`);
  await expectMsg("fresh account checks as unused or at risk", /Not used yet|At risk/, from, 30_000);
  await act("fresh account funded", () => native(alpha, [msg.bank.send({ fromAddress: alpha.cosmos, toAddress: fresh.cosmos, amount: [{ denom: "uqor", amount: "1000000" }] })]), /Received 1 QOR[\s\S]*Fresh/);
  from = msgs().length;
  await ensureKey(fresh);
  await expectMsg("fresh account's post-quantum key registration alerted", /Post-quantum key registered/, from);
  await sleep(4000);
  const falseAlarm = msgs().slice(from).some((m) => /classical-only signature/.test(m));
  results.push({ step: "no classical-only false alarm on key registration", pass: !falseAlarm, detail: falseAlarm ? "warned" : "quiet" });
  from = msgs().length;
  say(`/check ${fresh.cosmos}`);
  await expectMsg("fresh account now quantum-ready", /Quantum-ready/, from, 30_000);

  // 9. The bot's own view of things.
  from = msgs().length;
  say("/history");
  await expectMsg("/history of the linked wallet", /Last \d transactions?/, from, 30_000);
  from = msgs().length;
  say("/check");
  await expectMsg("/check of the linked wallet", /Account check[\s\S]*\/100/, from, 30_000);
} catch (e) {
  results.push({ step: "scenario", pass: false, detail: (e as Error).message });
} finally {
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined))?.json().catch(() => undefined);
  bot.kill("SIGTERM");
  await sleep(1500);
  await tg.stop();
  rmSync(data, { recursive: true, force: true });
  const passed = results.filter((r) => r.pass).length;
  const report = { at: new Date().toISOString(), passed, total: results.length, health, results, warnings: logs.filter((l) => /"level":"(warn|error)"/.test(l)).slice(0, 20), accounts: { alpha: alpha.cosmos, bravo: bravo.cosmos, fresh: fresh.cosmos } };
  if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(report, null, 1));
  console.log(`\nRESULT ${passed}/${results.length}`);
  for (const r of results) console.log(`${r.pass ? "✓" : "✗"} ${r.step}${r.pass ? "" : ` — ${r.detail}`}`);
  process.exit(passed === results.length ? 0 : 1);
}
