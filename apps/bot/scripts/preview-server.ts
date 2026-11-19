/**
 * Local preview: the HTTP server and web pages against the live testnet, without Telegram.
 * Seeds a link code and an attest code for chat 1 and prints them.
 * Usage: pnpm --filter @qorewatch/web build && tsx scripts/preview-server.ts
 */
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { Store } from "../src/db/store.js";
import { createChain } from "../src/chain.js";
import { createServer } from "../src/server/http.js";
import { createLogger } from "../src/log.js";

const port = Number(process.env.PORT ?? 8799);
const store = new Store(":memory:");
store.ensureChat(1, "private");
const owned = process.env.OWNED;
if (owned) store.addWatch(1, owned, { owned: true });
const link = store.createCode(1, "link");
const attest = store.createCode(1, "attest");
const chain = createChain({ network: "testnet" });
let head = (await chain.rpc.status()).height;
setInterval(async () => (head = (await chain.rpc.status()).height), 10_000).unref();
const app = createServer({
  config: { telegramToken: "x", botUsername: "qorewatchbot", publicUrl: `http://127.0.0.1:${port}`, network: "testnet", dataDir: ":memory:", httpHost: "127.0.0.1", httpPort: port, adminChatIds: [], maxCatchupBlocks: 0, pollMs: 0, logLevel: "warn", ...(process.env.ATTEST_CONTRACT ? { attestContract: process.env.ATTEST_CONTRACT } : {}) },
  store,
  chain,
  log: createLogger("warn"),
  webDir: resolve(import.meta.dirname, "../../web/dist"),
  status: () => ({ height: head, chainHeight: head, lagBlocks: 0 }),
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, link, attest }));
