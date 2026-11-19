/**
 * Configuration from the environment. Secrets (the Telegram token) only ever come from
 * the environment or a local .env file that is never committed. See .env.example.
 */
export interface Config {
  telegramToken: string;
  /** For tests: a fake Bot API. Defaults to https://api.telegram.org. */
  telegramApiRoot?: string;
  botUsername: string;
  /** Public HTTPS origin that serves the link, fix and attest pages (e.g. https://qorewatch.example.com). */
  publicUrl: string;
  network: "testnet" | "mainnet";
  rpcUrl?: string;
  restUrl?: string;
  evmRpcUrl?: string;
  dataDir: string;
  httpHost: string;
  httpPort: number;
  /** Telegram chat ids that receive operational notices (optional). */
  adminChatIds: number[];
  /** On a fresh start or after a long outage, scan at most this many past blocks. */
  maxCatchupBlocks: number;
  pollMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** The QoreWatch attest contract (EVM address), once deployed. */
  attestContract?: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new ConfigError(`Missing ${k}. Copy apps/bot/.env.example to apps/bot/.env and fill it in.`);
    return v;
  };
  const token = need("TELEGRAM_BOT_TOKEN");
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new ConfigError("TELEGRAM_BOT_TOKEN does not look like a BotFather token (digits:letters).");
  const publicUrl = need("PUBLIC_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(publicUrl)) throw new ConfigError("PUBLIC_URL must start with https:// (http:// only for local testing).");
  const network = (env.QORE_NETWORK?.trim() || "testnet") as Config["network"];
  if (network !== "testnet" && network !== "mainnet") throw new ConfigError("QORE_NETWORK must be testnet or mainnet.");
  const int = (k: string, d: number) => {
    const v = env[k]?.trim();
    if (!v) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${k} must be a whole number.`);
    return n;
  };
  const opt = (k: string) => env[k]?.trim() || undefined;
  const level = (env.LOG_LEVEL?.trim() || "info") as Config["logLevel"];
  const attest = opt("ATTEST_CONTRACT");
  if (attest && !/^0x[0-9a-fA-F]{40}$/.test(attest)) throw new ConfigError("ATTEST_CONTRACT must be a 0x address.");
  return {
    telegramToken: token,
    ...(opt("TELEGRAM_API_ROOT") ? { telegramApiRoot: opt("TELEGRAM_API_ROOT")! } : {}),
    botUsername: (opt("BOT_USERNAME") ?? "qorewatchbot").replace(/^@/, ""),
    publicUrl,
    network,
    ...(opt("QORE_RPC_URL") ? { rpcUrl: opt("QORE_RPC_URL")! } : {}),
    ...(opt("QORE_REST_URL") ? { restUrl: opt("QORE_REST_URL")! } : {}),
    ...(opt("QORE_EVM_RPC_URL") ? { evmRpcUrl: opt("QORE_EVM_RPC_URL")! } : {}),
    dataDir: opt("DATA_DIR") ?? "./data",
    httpHost: opt("HTTP_HOST") ?? "127.0.0.1",
    httpPort: int("HTTP_PORT", 8787),
    adminChatIds: (opt("ADMIN_CHAT_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n)) throw new ConfigError("ADMIN_CHAT_IDS must be comma-separated Telegram chat ids.");
        return n;
      }),
    maxCatchupBlocks: int("MAX_CATCHUP_BLOCKS", 3000),
    pollMs: int("POLL_MS", 1500),
    logLevel: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
    ...(attest ? { attestContract: attest.toLowerCase() } : {}),
  };
}
