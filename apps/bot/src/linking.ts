import { esc, shortAddress, type TxRecord } from "@qorewatch/core";
import type { Store } from "./db/store.js";
import type { Messenger } from "./telegram/messenger.js";
import { pages } from "./links.js";

/** The memo the link page asks QoreX to sign: "QoreWatch link ABCD2345". */
export const LINK_MEMO = (code: string) => `QoreWatch link ${code}`;
const LINK_RE = /\bQoreWatch link ([A-HJ-NP-Z2-9]{8})\b/;

export type LinkOutcome = { linked: true; chatId: number; address: string } | { linked: false; reason: "no_code" | "failed_tx" | "not_hybrid" | "no_signer" | "fee_grant" | "bad_code" };

/**
 * Complete a link when a transaction carries a QoreWatch link code in its memo.
 * The signer of a successful, hybrid-signed (ML-DSA-87) transaction is the address
 * that gets linked: only its owner could have produced that signature.
 */
export async function handleLinkTx(tx: TxRecord, store: Store, messenger: Messenger, publicUrl: string): Promise<LinkOutcome> {
  const m = LINK_RE.exec(tx.memo);
  if (!m) return { linked: false, reason: "no_code" };
  if (tx.failed) return { linked: false, reason: "failed_tx" };
  if (!tx.signer) return { linked: false, reason: "no_signer" };
  if (!tx.hybridSigned) return { linked: false, reason: "not_hybrid" };
  // The link page sends a plain self-transfer paid by the signer. A link paid through someone else's fee
  // allowance is never needed, so it is refused outright (defence in depth for audit F-8).
  if (tx.feeGranter) return { linked: false, reason: "fee_grant" };
  const used = store.consumeCode(m[1]!, "link", tx.signer);
  if (!used) return { linked: false, reason: "bad_code" };
  const isNew = !store.watch(used.chatId, tx.signer);
  if (!store.addWatch(used.chatId, tx.signer, { owned: true, linkedTx: tx.hash, label: isNew ? "My wallet" : null })) {
    await messenger.send(used.chatId, "⚠️ Your link transaction arrived, but this chat already watches the maximum number of addresses. Remove one with /list and link again.");
    return { linked: false, reason: "bad_code" };
  }
  await messenger.send(
    used.chatId,
    [
      "✅ <b>Wallet linked</b>",
      `<code>${esc(tx.signer)}</code>`,
      "",
      "QoreX signed the link with your post-quantum key (ML-DSA-87), so I know this address is yours. From now on I alert you about money moves, key changes, spending windows and new permissions on it.",
      "",
      `Link transaction: <code>${esc(shortAddress(tx.hash, 10, 6))}</code>`,
    ].join("\n"),
    [
      [
        { text: "🩺 Check this account", data: `c:${tx.signer}` },
        { text: "⚙️ Alert settings", data: `w:o:${tx.signer}` },
      ],
      [{ text: "🔎 Link transaction", url: pages(publicUrl).tx(tx.hash) }],
    ],
  );
  return { linked: true, chatId: used.chatId, address: tx.signer };
}
