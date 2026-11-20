import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { classify, explainTx, isEvmAddress, plain, qorToEvm, toQor, isQorAddress } from "@qorewatch/core";
import { canonicalReport, codeBytes, rememberIssued, reportHash } from "../attest.js";
import type { Chain } from "../chain.js";
import type { Store } from "../db/store.js";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { explainCtx, fetchTx, riskFlags, runCheck } from "../lookups.js";
import { LINK_MEMO } from "../linking.js";

export interface ServerDeps {
  config: Config;
  store: Store;
  chain: Chain;
  log: Logger;
  /** Built web pages (apps/web/dist). */
  webDir?: string;
  status: () => { height?: number; chainHeight?: number; lagBlocks?: number; lastError?: string };
}

/** Pages that take a path parameter, served by one HTML file each. */
const PAGES: Record<string, string> = { "/link": "link.html", "/attest": "attest.html", "/fix/window": "fix-window.html", "/fix/authz": "fix-authz.html", "/fix/feegrant": "fix-feegrant.html", "/fix/approval": "fix-approval.html", "/fix/key": "fix-key.html", "/fix/session": "fix-session.html" };

/** A per-IP token bucket: public endpoints read a public chain, but must not be a free proxy. */
function rateLimit(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: perMinute, at: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    if (buckets.size > 10_000) buckets.clear();
    return true;
  };
}

/**
 * The bot's HTTP side: a health check, a small read-only JSON API for the web pages
 * (QoreChain's REST API sends no CORS headers, so pages read through here), and the
 * built pages themselves. It listens on localhost; a reverse proxy adds HTTPS.
 */
export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const allow = rateLimit(120);
  const ip = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if ((c.res.headers.get("content-type") ?? "").includes("text/html"))
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://evm-testnet.qore.host https://evm.qore.host https://rpc-testnet.qore.host https://rpc.qore.host https://api-testnet.qore.host https://api.qore.host; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
  });

  app.get("/healthz", (c) => {
    const s = deps.status();
    const healthy = s.height !== undefined && (s.lagBlocks ?? 0) < 600;
    return c.json({ ok: healthy, height: s.height ?? null, chainHeight: s.chainHeight ?? null, lagBlocks: s.lagBlocks ?? null, ...(s.lastError ? { lastError: s.lastError.slice(0, 200) } : {}) }, healthy ? 200 : 503);
  });

  const api = new Hono();
  api.use("*", async (c, next) => {
    if (!allow(ip(c))) return c.json({ error: "Too many requests, slow down." }, 429);
    c.header("Cache-Control", "no-store");
    await next();
  });
  const addr = (c: Context, name = "address") => {
    const v = toQor(c.req.param(name) ?? "");
    if (!v) throw new BadRequest("Not a QoreChain address.");
    return v;
  };

  api.get("/config", (c) =>
    c.json({
      network: deps.config.network,
      chainId: deps.chain.cfg.chainId,
      evmChainId: deps.chain.cfg.evmChainId,
      evmRpc: deps.chain.cfg.evmRpc,
      explorer: deps.chain.cfg.explorer,
      botUsername: deps.config.botUsername,
      attestContract: deps.config.attestContract ?? null,
    }),
  );

  // The link page shows the memo to sign and waits for the bot to see it on chain.
  api.get("/link/:code", (c) => {
    const code = c.req.param("code").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return c.json({ status: "invalid" }, 400);
    const info = deps.store.codeInfo(code);
    if (!info || info.purpose !== "link") return c.json({ status: "invalid" }, 404);
    if (info.usedAt) return c.json({ status: "linked", address: info.address });
    if (info.expiresAt < Date.now()) return c.json({ status: "expired" });
    return c.json({ status: "pending", memo: LINK_MEMO(code), expiresAt: info.expiresAt });
  });

  // Before QoreX signs, the page binds the code to the connected address: a copied code is then useless.
  api.post("/link/:code/claim", async (c) => {
    const code = c.req.param("code").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return c.json({ error: "This link is not valid." }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { address?: unknown };
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    if (!isQorAddress(address) || address.length > 60) return c.json({ error: "Connect QoreX with a qor1 account first." }, 400);
    const r = deps.store.claimCode(code, address);
    if (r === "taken") return c.json({ error: "This code is already tied to another address. Send /link in Telegram for a new one." }, 409);
    if (r === "invalid") return c.json({ error: "This link has expired or was already used. Send /link in Telegram for a new one." }, 410);
    return c.json({ status: "claimed", address });
  });

  api.get("/attest/:code", async (c) => {
    const code = c.req.param("code").toUpperCase();
    const info = /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? deps.store.codeInfo(code) : undefined;
    if (!info || info.purpose !== "attest") return c.json({ status: "invalid" }, 404);
    if (info.usedAt) return c.json({ status: "attested", address: info.address });
    if (info.expiresAt < Date.now()) return c.json({ status: "expired" });
    const owned = deps.store.watches(info.chatId).filter((w) => w.owned).map((w) => w.address);
    return c.json({ status: "pending", accounts: owned, expiresAt: info.expiresAt });
  });

  // The attest page asks for a fresh report for one of the chat's linked accounts, then submits its hash.
  api.get("/attest/:code/report", async (c) => {
    const code = c.req.param("code").toUpperCase();
    const info = /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? deps.store.codeInfo(code) : undefined;
    if (!info || info.purpose !== "attest" || info.usedAt || info.expiresAt < Date.now()) return c.json({ error: "This attest link is no longer valid. Ask the bot for a new one with /attest." }, 404);
    const account = toQor(c.req.query("account") ?? "");
    if (!account || !deps.store.watch(info.chatId, account)?.owned) return c.json({ error: "Pick an account you linked in this chat." }, 400);
    if (!deps.config.attestContract) return c.json({ error: "Attestations are not set up on this deployment." }, 503);
    const r = await runCheck({ chain: deps.chain, store: deps.store, publicUrl: deps.config.publicUrl }, account);
    const hash = reportHash(canonicalReport(r));
    rememberIssued(deps.store, code, account, r.score, hash);
    return c.json({ account, evmAccount: qorToEvm(account), score: r.score, status: r.status, reportHash: hash, code: codeBytes(code), contract: deps.config.attestContract });
  });

  api.get("/window/:address", async (c) => {
    const a = addr(c);
    const w = await deps.chain.rest.evmWindow(a);
    const head = deps.status().chainHeight ?? deps.status().height;
    return c.json({ ...json(w), height: head ?? null, blockSeconds: deps.chain.cfg.blockSeconds });
  });

  api.get("/account/:address", async (c) => {
    const a = addr(c);
    const [pqc, auth] = await Promise.all([deps.chain.rest.pqcAccount(a), deps.chain.rest.authAccount(a)]);
    return c.json({ address: a, pqc, auth });
  });

  api.get("/grants/:address", async (c) => {
    const a = addr(c);
    const [grants, feeAllowances, smart] = await Promise.all([deps.chain.rest.grantsByGranter(a), deps.chain.rest.feeAllowancesIssued(a), deps.chain.rest.abstractAccount(a).catch(() => undefined)]);
    return c.json(json({ grants, feeAllowances, smartAccount: smart ?? null }));
  });

  api.get("/allowance", async (c) => {
    const owner = c.req.query("owner") ?? "";
    const token = c.req.query("token") ?? "";
    const spender = c.req.query("spender") ?? "";
    if (![owner, token, spender].every(isEvmAddress)) return c.json({ error: "owner, token and spender must be 0x addresses" }, 400);
    const [value, info] = await Promise.all([deps.chain.evm.allowance(token, owner, spender), deps.chain.tokens.get(token)]);
    return c.json({ value: value.toString(), symbol: info.symbol, decimals: info.decimals });
  });

  api.get("/check/:address", async (c) => {
    const a = addr(c);
    const r = await runCheck({ chain: deps.chain, store: deps.store, publicUrl: deps.config.publicUrl }, a);
    const handle = await deps.chain.handles.reverse(a);
    return c.json(json({ ...r, handle: handle ?? null, findings: r.findings.map((f) => ({ ...f, title: plain(f.title), detail: plain(f.detail) })) }));
  });

  api.get("/tx/:hash", async (c) => {
    const l = classify(c.req.param("hash"));
    if (l.kind !== "tx") return c.json({ error: "Not a transaction hash." }, 400);
    const lk = { chain: deps.chain, store: deps.store, publicUrl: deps.config.publicUrl };
    const tx = await fetchTx(lk, l.hash);
    if (!tx) return c.json({ error: "Transaction not found on QoreChain." }, 404);
    const e = await explainTx(tx, explainCtx(lk, 0, undefined, deps.status().chainHeight));
    return c.json(
      json({
        hash: tx.hash,
        evmHash: tx.evmHash ?? null,
        height: tx.height,
        time: tx.time,
        failed: tx.failed,
        failReason: tx.failReason ?? null,
        signer: tx.signer ?? null,
        hybridSigned: tx.hybridSigned,
        classicalOnly: tx.classicalOnly,
        memo: tx.memo,
        title: plain(e.title),
        lines: e.lines.map(plain),
        flags: riskFlags(tx).map(plain),
        messages: tx.messages.map((m) => m.typeUrl),
        explorer: `${deps.chain.cfg.explorer}/tx/${tx.hash}`,
      }),
    );
  });

  api.onError((e, c) => {
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    deps.log.warn("api error", { error: e.message });
    return c.json({ error: "QoreChain's public node did not answer. Try again in a moment." }, 502);
  });
  app.route("/api", api);

  // ---- pages ---------------------------------------------------------------------------------------------
  const web = deps.webDir;
  if (web && existsSync(web)) {
    const page = (file: string) => (c: Context) => c.html(readFileSync(join(web, file), "utf8"));
    for (const [path, file] of Object.entries(PAGES)) if (existsSync(join(web, file))) app.get(path, page(file));
    if (existsSync(join(web, "tx.html"))) app.get("/tx/:hash", page("tx.html"));
    if (existsSync(join(web, "check.html"))) app.get("/check/:address", page("check.html"));
    app.use("/*", serveStatic({ root: relative(process.cwd(), web) || "." }));
  }
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

class BadRequest extends Error {}

/** JSON-safe copy (bigints as strings). */
function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as T;
}

