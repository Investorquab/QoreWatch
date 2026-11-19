import { duration, esc, qor, shortAddress, type ChainEvent } from "@qorewatch/core";
import type { Alert, Button, DetectContext, TxDetector } from "../types.js";
import { pages } from "../../links.js";
import { detailsButton, keyOf, said, subject } from "./util.js";

const fix = (ctx: DetectContext) => pages(ctx.publicUrl);

/**
 * Post-quantum security events on a watched address: key changes, EVM spending windows,
 * delegations, permissions (authz, fee grants), smart-account session keys and spending
 * rules, classical-only signatures and QoreChain's own anomaly flag.
 */
export const securityDetector: TxDetector = {
  id: "security",
  async detect(tx, ctx) {
    const a = ctx.watch.address;
    const out: Alert[] = [];
    const add = async (ev: ChainEvent, part: string, level: Alert["level"], title: string, extra: string[] = [], buttons: Button[][] = []) => {
      out.push({
        key: keyOf(tx, "security", a, part),
        category: "security",
        level,
        address: a,
        title,
        body: [await said(ev, ctx), ...extra],
        buttons: [...buttons, [detailsButton(ctx, tx)]],
        txHash: tx.hash,
      });
    };
    const youDid = ctx.watch.owned ? "If this was not you, someone else holds your post-quantum key: move your funds to a new wallet now." : "";
    for (const ev of tx.events) {
      switch (ev.kind) {
        case "pq_key_registered":
          if (ev.address === a) await add(ev, "pqreg", "info", `🛡 <b>Post-quantum key registered</b>`, ["The account is now protected by ML-DSA-87: every transaction needs it."]);
          break;
        case "pq_key_rotated":
          if (ev.address === a)
            await add(ev, "pqrot", "critical", `🚨 <b>The post-quantum key of ${subject(ctx)} changed. Was this you?</b>`, [
              "A key change is the clearest sign of an account takeover.",
              ...(youDid ? [`<b>${youDid}</b>`] : []),
            ], [[{ text: "🩺 Check the account", data: `c:${a}` }]]);
          break;
        case "pq_key_migrated":
          if (ev.address === a)
            await add(ev, "pqmig", "critical", `🚨 <b>A post-quantum key migration started on ${subject(ctx)}</b>`, ["A new key is set to replace the current one.", ...(youDid ? [`<b>${youDid}</b>`] : [])], [[{ text: "🩺 Check the account", data: `c:${a}` }]]);
          break;
        case "kem_key_registered":
          if (ev.address === a) await add(ev, "kem", ev.replaced ? "warning" : "info", ev.replaced ? "🔑 <b>Encryption key replaced</b>" : "🔑 <b>Encryption key registered</b>", ev.replaced ? ["Messages sealed to the old key can no longer be opened with the new one. If you did not do this, someone may be redirecting encrypted messages meant for you."] : []);
          break;
        case "kem_key_removed":
          if (ev.address === a) await add(ev, "kemrm", "warning", "🔑 <b>Encryption key removed</b>");
          break;
        case "window_opened":
          if (ev.address === a) {
            const any = ev.allowedTargets.length === 0;
            const left = ev.expiryHeight - tx.height;
            await add(
              ev,
              `win${ev.expiryHeight}`,
              any ? "warning" : "info",
              any ? `🪟 <b>A spending window opened on ${subject(ctx)}, to any recipient</b>` : `🪟 <b>A spending window opened on ${subject(ctx)}</b>`,
              [
                `For about ${duration(left, ctx.blockSeconds)}, ${ev.maxTxs} transaction${ev.maxTxs === 1 ? "" : "s"} worth up to ${qor(ev.maxValueUqor)} can be sent ${any ? "<b>to any address</b>" : "to the allowed contract only"}.`,
                "While it is open, the classical key alone can spend inside it. Close it in QoreX when you are done.",
              ],
              [[{ text: "🛠 Close the window", url: fix(ctx).fixWindow(a) }]],
            );
          }
          break;
        case "window_used":
          if (ev.address === a)
            out.push({
              key: keyOf(tx, "security", a, "winuse"),
              category: "security",
              level: "info",
              address: a,
              title: `🪟 <b>Spent from the open window</b>`,
              body: [await said(ev, ctx)],
              buttons: [[{ text: "🛠 Close the window", url: fix(ctx).fixWindow(a) }, detailsButton(ctx, tx)]],
              txHash: tx.hash,
            });
          break;
        case "window_closed":
          if (ev.address === a) await add(ev, "winclose", "info", "✅ <b>Spending window closed</b>", ["The classical key can no longer spend from this account on the EVM lane."]);
          break;
        case "evm_delegation_consent":
          if (ev.address === a)
            await add(ev, `dlg${ev.delegate}`, "warning", `🗝 <b>Another address can now act for ${subject(ctx)}</b>`, ["An EVM delegation lets that address's code act as your EVM account."]);
          break;
        case "evm_delegation_cleared":
          if (ev.address === a) await add(ev, `dlgclr${ev.delegate}`, "info", "✅ <b>EVM delegation withdrawn</b>");
          break;
        case "authz_grant":
          if (ev.granter === a)
            await add(ev, `authz${ev.grantee}${ev.msgTypeUrl}`, "warning", `🗝 <b>Someone can now act for ${subject(ctx)}</b>`, ["Permissions like this are a quiet way wallets get drained later. Revoke it if you don't recognise it."], [[{ text: "🛠 Revoke this permission", url: fix(ctx).fixAuthz(a, ev.grantee, ev.msgTypeUrl) }]]);
          else if (ev.grantee === a) await add(ev, `authzin${ev.granter}${ev.msgTypeUrl}`, "info", "🗝 <b>You were given a permission</b>");
          break;
        case "authz_revoke":
          if (ev.granter === a || ev.grantee === a) await add(ev, `authzrv${ev.grantee}${ev.msgTypeUrl}`, "info", "✅ <b>Permission revoked</b>");
          break;
        case "authz_exec":
          break;
        case "feegrant_set":
          if (ev.granter === a)
            await add(ev, `fee${ev.grantee}`, "warning", `⛽ <b>Someone can now spend ${subject(ctx)}'s QOR on fees</b>`, [], [[{ text: "🛠 Stop paying their fees", url: fix(ctx).fixFeegrant(a, ev.grantee) }]]);
          break;
        case "feegrant_revoke":
          if (ev.granter === a) await add(ev, `feerv${ev.grantee}`, "info", "✅ <b>Fee allowance revoked</b>");
          break;
        case "aa_created":
          if (ev.account === a || ev.owner === a) await add(ev, "aacreate", "info", "🧩 <b>Turned into a smart account</b>");
          break;
        case "aa_authenticator_added":
          if (ev.account === a)
            await add(ev, `aaadd${ev.scheme}${ev.label ?? ""}`, "warning", `🗝 <b>A session key can now sign for ${subject(ctx)}</b>`, ["Session keys let an app or agent act within the smart account's spending rules."], [[{ text: "🛠 How to remove it", url: fix(ctx).fixSession(a) }]]);
          break;
        case "aa_authenticator_revoked":
          if (ev.account === a) await add(ev, `aarm${ev.scheme}`, "info", "✅ <b>Session key removed</b>");
          break;
        case "aa_spending_rules":
          if (ev.account === a) await add(ev, "aarules", "info", "🧩 <b>Smart-account spending rules changed</b>");
          break;
        case "classical_only":
          // Registering the account's first post-quantum key is necessarily classical-only: that is the bootstrap, not an attack.
          if (tx.events.some((e) => e.kind === "pq_key_registered" && e.address === ev.address)) break;
          if (ev.address === a) await add(ev, "classical", "warning", `⚠️ <b>A classical-only signature was used on ${subject(ctx)}</b>`, ["QoreChain normally requires the post-quantum signature as well. This is how a quantum attacker would sign."]);
          break;
        case "anomaly":
          if (ev.flagged && tx.signer === a) await add(ev, "anomaly", "warning", `🧠 <b>QoreChain's anomaly check flagged a transaction from ${subject(ctx)}</b>`);
          break;
      }
    }
    return out;
  },
};

/** A short label for an address in button text. */
export const brief = (a: string) => esc(shortAddress(a, 8, 4));
