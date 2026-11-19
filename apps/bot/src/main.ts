import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./log.js";
import { Store } from "./db/store.js";
import { createChain } from "./chain.js";
import { Deliverer } from "./alerts/deliver.js";
import { Pacer } from "./telegram/messenger.js";
import { COMMANDS, createBot } from "./telegram/bot.js";
import { Watcher } from "./watcher/watcher.js";
import { Jobs } from "./watcher/jobs.js";
import { createServer } from "./server/http.js";
import { renderCard } from "./cards/card.js";
import { runCheck } from "./lookups.js";
import { poolPrices } from "./features/pools.js";
import { proposalsView } from "./features/governance.js";
import { buildDigest } from "./features/digest.js";
import { attestHook } from "./attest.js";

/** Where the built web pages are: WEB_DIR, or apps/web/dist next to this app. */
function webDir(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [process.env.WEB_DIR, resolve(here, "../../web/dist"), resolve(here, "../web"), resolve(process.cwd(), "../web/dist")].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "link.html")));
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`QoreWatch cannot start: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  const store = new Store(join(config.dataDir, "qorewatch.sqlite"));
  const chain = createChain(config);
  const pacer = new Pacer();
  // The watcher is created after the bot (it sends through the bot), but the bot's /status reads it.
  const ref: { watcher?: Watcher } = {};
  const lk = { chain, store, publicUrl: config.publicUrl };

  const { bot, messenger } = createBot({
    config,
    store,
    chain,
    log,
    pacer,
    hooks: {
      status: () => ({ ...(ref.watcher?.status ?? { startedAt: new Date().toISOString() }) }),
      card: async (address) => {
        const [report, handle] = await Promise.all([runCheck(lk, address), chain.handles.reverse(address)]);
        return renderCard(report, { ...(handle ? { handle } : {}), botUsername: config.botUsername });
      },
      pools: async () => poolPrices(await chain.rest.pools(), chain.tokens),
      proposals: async () => proposalsView(await chain.rest.proposals(undefined, 10)),
      digest: (chatId) => buildDigest(chatId, store, chain, false),
    },
  });

  const deliverer = new Deliverer(store, messenger, log);
  const watcher = new Watcher({ chain, store, deliverer, messenger, log, publicUrl: config.publicUrl, maxCatchupBlocks: config.maxCatchupBlocks });
  ref.watcher = watcher;
  const jobs = new Jobs({ store, chain, deliverer, messenger, log, publicUrl: config.publicUrl, height: () => watcher.status.height });
  const attest = config.attestContract ? attestHook({ store, chain, messenger, log, contract: config.attestContract, publicUrl: config.publicUrl }) : undefined;

  const web = webDir();
  const app = createServer({ config, store, chain, log, ...(web ? { webDir: web } : {}), status: () => watcher.status });
  const server = serve({ fetch: app.fetch, hostname: config.httpHost, port: config.httpPort });
  log.info("http server listening", { host: config.httpHost, port: config.httpPort, pages: web ? "yes" : "no (build apps/web)" });

  await bot.init();
  await bot.api.setMyCommands(COMMANDS).catch((e) => log.warn("could not set the command menu", { error: (e as Error).message }));
  await bot.api
    .setMyDescription("I watch QoreChain addresses and message you when money moves, your post-quantum key changes, a spending window opens or someone gets permission to spend for you. Link your wallet with QoreX: I never see a key.")
    .catch(() => undefined);
  await bot.api.setMyShortDescription("Post-quantum wallet alerts for QoreChain.").catch(() => undefined);
  log.info("telegram bot ready", { username: bot.botInfo.username });

  const loops: Promise<unknown>[] = [];
  loops.push(watcher.run(config.pollMs));
  const jobTimer = setInterval(() => void jobs.runDue(), 20_000);
  const attestTimer = attest ? setInterval(() => void attest.scan(watcher.status.height), 15_000) : undefined;
  loops.push(bot.start({ drop_pending_updates: false, allowed_updates: ["message", "callback_query", "my_chat_member"], onStart: () => log.info("polling Telegram for updates") }));

  for (const admin of config.adminChatIds) await messenger.send(admin, `🟢 QoreWatch started on ${config.network}.`).catch(() => undefined);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    clearInterval(jobTimer);
    if (attestTimer) clearInterval(attestTimer);
    watcher.stop();
    await bot.stop().catch(() => undefined);
    server.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  await Promise.all(loops);
}

main().catch((e) => {
  process.stderr.write(`QoreWatch crashed: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
