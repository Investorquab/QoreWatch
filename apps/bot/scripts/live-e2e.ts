/**
 * Live end-to-end run of the production bundle (dist/main.js): a local fake Telegram
 * Bot API, the real QoreChain testnet, no keys. It drives the bot like a user, watches
 * busy real accounts, and reports every message the bot sends.
 * Usage: pnpm --filter @qorewatch/bot build && tsx scripts/live-e2e.ts [minutes] [address ...]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTelegram } from "../test/fake-telegram.js";

const minutes = Number(process.argv[2] ?? 3);
const watch = process.argv.slice(3);
const tg = new FakeTelegram();
const root = await tg.start();
const data = mkdtempSync(join(tmpdir(), "qw-live-"));
const port = 8797;
const env = { ...process.env, TELEGRAM_BOT_TOKEN: tg.token, TELEGRAM_API_ROOT: root, PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: data, HTTP_PORT: String(port), LOG_LEVEL: "info", POLL_MS: "1500" };
const bot = spawn(process.execPath, ["dist/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
const logs: string[] = [];
bot.stdout.on("data", (d) => logs.push(...String(d).trim().split("\n")));
bot.stderr.on("data", (d) => logs.push(...String(d).trim().split("\n")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER = 4242;
const say = (t: string) => tg.push(tg.text(USER, t) as never);
const sent = () => tg.calls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === USER).map((c) => String(c.body.text));

await sleep(8000);
const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
console.log("HEALTH", JSON.stringify(health));
const steps: [string, RegExp][] = [
  ["/start", /I'm QoreWatch/],
  ...watch.map((a, i) => [`/watch ${a} Live${i + 1}`, /Watching/] as [string, RegExp]),
  ["/check qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7", /Account check/],
  ["/tx ABD4D48E4CF3E3CDFA9019D6A0B92D3D5D8F6641438CE6AA7378356277FF4002", /EVM transaction/],
  ["/history qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7", /Last \d transaction/],
  ["/pools", /swap pools/],
  ["/proposals", /proposal/i],
  ["/status", /in sync|blocks behind/],
  ["/digest now", /digest/i],
];
let ok = 0;
for (const [cmd, expect] of steps) {
  const before = sent().length;
  say(cmd);
  let got = "";
  for (let i = 0; i < 40 && !got; i++) {
    await sleep(500);
    const s = sent();
    if (s.length > before) got = s.slice(before).join("\n---\n");
  }
  const pass = expect.test(got);
  ok += pass ? 1 : 0;
  console.log(`${pass ? "PASS" : "FAIL"} ${cmd.slice(0, 60)} -> ${got.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
}
const photosBefore = tg.calls.filter((c) => c.method === "sendPhoto").length;
tg.push(tg.press(USER, "card:qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7") as never);
await sleep(6000);
const photo = tg.calls.filter((c) => c.method === "sendPhoto").length > photosBefore;
console.log(`${photo ? "PASS" : "FAIL"} share card photo`);
console.log(`COMMANDS ${ok}/${steps.length} passed`);

const startCount = sent().length;
console.log(`watching live for ${minutes} min…`);
await sleep(minutes * 60_000);
const alerts = sent().slice(startCount);
console.log(`LIVE ALERTS ${alerts.length}`);
for (const a of alerts.slice(0, 12)) console.log("ALERT", a.replace(/\n/g, " ⏎ ").slice(0, 220));
const status = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
console.log("HEALTH", JSON.stringify(status));
console.log("LOG ERRORS", logs.filter((l) => /"level":"(warn|error)"|crash/i.test(l)).slice(0, 8).join("\n"));
bot.kill("SIGTERM");
await sleep(1500);
console.log("EXIT", bot.exitCode, bot.signalCode);
await tg.stop();
rmSync(data, { recursive: true, force: true });
process.exit(0);
