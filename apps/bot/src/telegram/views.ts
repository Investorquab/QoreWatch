import { esc, formatUnits, plain, shortAddress, STATUS_LABEL, type Coin, type HealthReport, type Tokens } from "@qorewatch/core";
import type { Button } from "../alerts/types.js";
import { CATEGORIES, CATEGORY_LABEL } from "../alerts/types.js";
import { clock } from "../alerts/time.js";
import type { Chat, Watch } from "../db/store.js";
import { pages } from "../links.js";

export interface View {
  html: string;
  buttons?: Button[][];
}

export const MAIN_MENU: Button[][] = [
  [
    { text: "🔗 Link my wallet", data: "menu:link" },
    { text: "👁 Watch an address", data: "menu:watch" },
  ],
  [
    { text: "🩺 Check an address", data: "menu:check" },
    { text: "📋 My watches", data: "menu:list" },
  ],
  [
    { text: "⚙️ Settings", data: "menu:settings" },
    { text: "❓ Help", data: "menu:help" },
  ],
];

export function welcome(firstName?: string): View {
  return {
    html: [
      `👋 <b>Hi${firstName ? ` ${esc(firstName)}` : ""}, I'm QoreWatch.</b>`,
      "",
      "I watch QoreChain addresses and message you the moment something happens:",
      "💸 money in and out, in plain words",
      "🔐 your post-quantum key changing",
      "🪟 an EVM spending window opening on your account",
      "🗝 someone getting permission to spend for you",
      "",
      "Start by linking your wallet with QoreX (you approve one tiny transaction, I never see a key), or just watch any address.",
    ].join("\n"),
    buttons: MAIN_MENU,
  };
}

export function help(): View {
  return {
    html: [
      "<b>QoreWatch commands</b>",
      "",
      "<b>Your addresses</b>",
      "/link: prove an address is yours with QoreX",
      "/watch <code>address|@handle [label]</code>: watch any address, read-only",
      "/list: your watched addresses and their settings",
      "",
      "<b>Look things up</b>",
      "/check <code>address|@handle</code>: post-quantum health score and fixes",
      "/tx <code>hash</code>: explain any transaction in plain words",
      "/history <code>address</code>: the last transactions, explained",
      "Paste or forward any address or hash and I'll tell you if it looks safe.",
      "",
      "<b>Alerts</b>",
      "/settings: categories, quiet hours, time zone, digest",
      "/quiet <code>23:00-07:00</code> or <code>off</code>",
      "/timezone <code>Africa/Lagos</code>",
      "/threshold <code>address amount</code>: skip money alerts below an amount",
      "/digest <code>08:00</code>, <code>off</code> or <code>now</code>",
      "/pause and /resume",
      "",
      "<b>Market and network</b>",
      "/pools: QoreChain's swap pools and prices",
      "/pricealert <code>pool percent</code>: alert when a pool's price moves",
      "/proposals: governance proposals",
      "",
      "/attest: record on chain that you checked your account",
      "/status: is QoreWatch keeping up with the chain?",
      "/privacy and /forget: what I store, and deleting it",
      "",
      "Security alerts marked critical always come through, even when paused or muted.",
    ].join("\n"),
    buttons: [[{ text: "⬅️ Menu", data: "menu:home" }]],
  };
}

export function addrLine(w: Pick<Watch, "address" | "label" | "owned">): string {
  return `${w.owned ? "✅" : "👁"} ${w.label ? `<b>${esc(w.label)}</b> · ` : ""}<code>${esc(shortAddress(w.address, 10, 6))}</code>`;
}

export function watchList(watches: Watch[], chat: Chat): View {
  if (!watches.length)
    return {
      html: "You are not watching any address yet.\n\nLink your own with /link, or send /watch followed by any address.",
      buttons: [[{ text: "🔗 Link my wallet", data: "menu:link" }, { text: "👁 Watch an address", data: "menu:watch" }]],
    };
  const lines = [`<b>Watching ${watches.length} address${watches.length === 1 ? "" : "es"}</b>${chat.paused ? " (paused)" : ""}`, "", ...watches.map(addrLine), "", "✅ linked with QoreX · 👁 read-only"];
  return {
    html: lines.join("\n"),
    buttons: [...watches.map((w) => [{ text: `${w.owned ? "✅" : "👁"} ${w.label ?? shortAddress(w.address, 10, 4)}`, data: `w:o:${w.address}` }]), [{ text: "⬅️ Menu", data: "menu:home" }]],
  };
}

export function watchDetail(w: Watch): View {
  const muted = w.muted.length ? w.muted.map((c) => CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] ?? c).join(", ") : "none";
  return {
    html: [
      addrLine(w),
      `<code>${esc(w.address)}</code>`,
      "",
      `Money alerts from: <b>${w.minUqor > 0n ? `${formatUnits(w.minUqor, 6)} QOR` : "any amount"}</b>`,
      `Muted here: ${esc(muted)}`,
      w.owned ? "Linked with QoreX: you proved this address is yours." : "Read-only: anyone can watch any address.",
    ].join("\n"),
    buttons: [
      [
        { text: "🩺 Check", data: `c:${w.address}` },
        { text: "🧾 History", data: `h:${w.address}` },
      ],
      [
        { text: "🏷 Rename", data: `w:lb:${w.address}` },
        { text: "💰 Threshold", data: `w:th:${w.address}` },
      ],
      [{ text: "🔕 Mute categories", data: `w:mm:${w.address}` }],
      [
        { text: "🗑 Stop watching", data: `w:rm:${w.address}` },
        { text: "⬅️ Back", data: "menu:list" },
      ],
    ],
  };
}

export function muteMenu(scope: "chat" | string, muted: string[]): View {
  const prefix = scope === "chat" ? "s:mute:" : `w:mt:${scope}:`;
  return {
    html: scope === "chat" ? "<b>Alert categories</b>\nTap to turn a category off or on for this chat." : "<b>Alert categories for this address</b>\nTap to turn one off or on.",
    buttons: [
      ...CATEGORIES.map((c) => [{ text: `${muted.includes(c) ? "🔕" : "🔔"} ${CATEGORY_LABEL[c]}`, data: `${prefix}${CATEGORIES.indexOf(c)}` }]),
      [{ text: "⬅️ Back", data: scope === "chat" ? "menu:settings" : `w:o:${scope}` }],
    ],
  };
}

export function settings(chat: Chat): View {
  const quiet = chat.quietStart !== null && chat.quietEnd !== null ? `${clock(chat.quietStart)} to ${clock(chat.quietEnd)}` : "off";
  const digest = chat.digestMinute !== null ? `daily at ${clock(chat.digestMinute)}` : "off";
  return {
    html: [
      "<b>Settings</b>",
      "",
      `Time zone: <b>${esc(chat.tz)}</b>`,
      `Quiet hours: <b>${quiet}</b> (security warnings still come through)`,
      `Daily digest: <b>${digest}</b>`,
      `Network notices: <b>${chat.networkAlerts ? "on" : "off"}</b>`,
      `Muted categories: <b>${chat.muted.length ? esc(chat.muted.map((c) => CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL] ?? c).join(", ")) : "none"}</b>`,
      `Alerts: <b>${chat.paused ? "paused" : "on"}</b>`,
    ].join("\n"),
    buttons: [
      [
        { text: "🔕 Categories", data: "s:cats" },
        { text: "🌙 Quiet hours", data: "s:quiet" },
      ],
      [
        { text: "🕰 Time zone", data: "s:tz" },
        { text: "📰 Digest", data: "s:digest" },
      ],
      [
        { text: chat.networkAlerts ? "📡 Network notices: on" : "📡 Network notices: off", data: "s:net" },
        { text: chat.paused ? "▶️ Resume alerts" : "⏸ Pause alerts", data: "s:pause" },
      ],
      [{ text: "⬅️ Menu", data: "menu:home" }],
    ],
  };
}

const STATUS_ICON = { ready: "🟢", attention: "🟠", at_risk: "🔴", unused: "⚪️" } as const;
const SEV_ICON = { critical: "🔴", warning: "🟠", info: "🔵", good: "🟢" } as const;

export async function checkReport(r: HealthReport, tokens: Tokens, publicUrl: string, opts: { handle?: string; watched: boolean }): Promise<View> {
  const p = pages(publicUrl);
  const bal = await balancesText(r.balances, tokens);
  const lines = [
    `🩺 <b>Account check</b>${opts.handle ? ` · @${esc(opts.handle)}` : ""}`,
    `<code>${esc(r.address)}</code>`,
    "",
    r.status === "unused" ? `${STATUS_ICON.unused} <b>${STATUS_LABEL.unused}</b>` : `${STATUS_ICON[r.status]} <b>${STATUS_LABEL[r.status]}</b> · <b>${r.score}</b>/100`,
    ...(bal ? [`Balance: ${bal}`] : []),
    "",
    ...r.findings.map((f) => `${SEV_ICON[f.severity]} <b>${f.title}</b>\n${f.detail}`),
  ];
  const fixes: Button[][] = [];
  for (const f of r.findings) {
    if (!f.fix) continue;
    switch (f.fix.kind) {
      case "qorex_register_key":
        fixes.push([{ text: "🛠 How to register a key", url: p.fixKey(r.address) }]);
        break;
      case "qorex_close_window":
        fixes.push([{ text: "🛠 Close the window", url: p.fixWindow(r.address) }]);
        break;
      case "revoke_authz":
        fixes.push([{ text: `🛠 Revoke ${shortAddress(f.fix.grantee, 8, 4)}`, url: p.fixAuthz(r.address, f.fix.grantee, f.fix.msgTypeUrl) }]);
        break;
      case "revoke_feegrant":
        fixes.push([{ text: `🛠 Stop paying ${shortAddress(f.fix.grantee, 8, 4)}'s fees`, url: p.fixFeegrant(r.address, f.fix.grantee) }]);
        break;
    }
  }
  return {
    html: lines.join("\n"),
    buttons: [
      ...fixes.slice(0, 6),
      [
        { text: "🖼 Share card", data: `card:${r.address}` },
        { text: "🔄 Check again", data: `c:${r.address}` },
      ],
      opts.watched ? [{ text: "🧾 History", data: `h:${r.address}` }] : [{ text: "👁 Watch this address", data: `watch:${r.address}` }, { text: "🧾 History", data: `h:${r.address}` }],
    ],
  };
}

export async function balancesText(coins: Coin[], tokens: Tokens): Promise<string> {
  const nonzero = coins.filter((c) => c.amount > 0n);
  if (!nonzero.length) return "";
  const parts = await Promise.all(nonzero.slice(0, 6).map((c) => tokens.format(c.amount, c.denom)));
  return parts.join(", ") + (nonzero.length > 6 ? ` and ${nonzero.length - 6} more` : "");
}

/** One-line plain summary for compact lists. */
export const firstLine = (html: string) => plain(html).split("\n")[0]!;
