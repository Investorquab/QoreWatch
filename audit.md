# QoreWatch security audit

An internal audit: we tried to break QoreWatch and wrote down what happened. Every result below was run against the code in this repository and, where noted, against the live QoreChain testnet (`qorechain-diana`) with the real QoreX 0.4.3 extension, or on a fresh Ubuntu 24.04 server. When something failed we fixed it and ran it again. The tables show the final state; **Findings** keeps the failures.

It is not a third-party audit. Known gaps are under **Limitations**.

| | |
| --- | --- |
| Date | 20 November 2026 |
| Commit audited | the commit that adds this file |
| Contract | `QoreWatchAttest` at `0x52f29cb4f18ec44acbb997b94c0776e4e35ed273` (testnet, block 10389715) |
| Wallet | QoreX 0.4.3 browser extension, testnet |
| Automated tests | 152, all passing: 54 core, 85 bot (4 of them security regressions from the second pass), 6 web, 7 Foundry |
| Second pass | 20 November 2026, an attacker-minded re-audit of commit `2f7d588` with working exploits, local only (section 7) |

## Summary

| Area | Checks | Result | Notes |
| --- | --- | --- | --- |
| Alerts on the live chain | 30 steps | 30 pass, 0 warnings | Every alert family from a real transaction, plus the copied-code attack |
| Pages with the real QoreX | 6 | 6 pass | Link, three revokes, window close by the guided steps, attest |
| Wallet linking | 4 attacks | all refused | Classical-only, failed, replayed and copied codes; **F-1** found and fixed here |
| Telegram side | tests | pass | Group admin rules, `/forget`, escaping of everything a sender controls |
| Web pages and API | tests + live browser | pass | CSP and headers, rate limit, escaping, zero console errors under the CSP |
| Deployment | 25 server checks | 25 pass | Fresh and shared Ubuntu 24.04 servers: install, alert, rollback, reboot, restore, upgrade, neighbours untouched; **F-2** and **F-7** found here |
| Secrets in the repository | 209 tracked files | none | Only the fake token of the test Bot API stand-in |

Seven findings, all fixed. None let anyone move funds, read anything private or silence a critical alert.

## Threat model

QoreWatch is an alert service, so its promises are about **truth** and **reach**, never custody:

1. **It never holds a key.** It cannot sign, so it cannot move anything. Linking and every fix are transactions the user approves in QoreX.
2. **A linked address is really yours.** "Your account" alerts, "was this you?" questions and `/attest` only apply to an address proved with a transaction signed with its ML-DSA-87 key.
3. **Alerts are accurate and critical ones always arrive.** A key change cannot be muted, paused or held by quiet hours.
4. **Nobody else can change what your chat watches.** In groups, only admins can.
5. **Its pages cannot be used against you.** They hold no state, run only their own scripts, and every transaction is built from explicit parameters that QoreX shows before signing.
6. **The server exposes as little as possible.** The bot listens on localhost only, runs unprivileged, and its token is readable by root only.

The headline attacker sees the public chain (including pending transactions), can send Telegram messages and HTTP requests, and may hold a classical key, the one a quantum computer could derive.

## 1. Alerts on the live chain

`apps/bot/scripts/live-scenario.ts` runs the production bot (`dist/main.js`) against the real testnet with a local stand-in for the Telegram API, and checks every message it sends. Final run, 20 November 2026, block 10422256: **30 of 30**, no warning or error in the bot's log.

| Step | Alert or check |
| --- | --- |
| 1-4 | `/link` code; the page's claim; **a copied code in someone else's real transaction links nobody**; the owner's hybrid-signed self-send links |
| 5-6 | read-only watches with labels |
| 7-8 | money in (0.5 QOR with its note) and out |
| 9-10 | EVM window opened to any recipient; a value transfer inside it |
| 11-12 | unlimited fUSD approval (warning with a revoke link); approval revoked |
| 13 | failed transaction from the account |
| 14-15 | `/attest` page; attestation recorded and matched against the issued report |
| 16-19 | authz grant and revoke; fee allowance grant and revoke |
| 20 | EVM delegation consent |
| 21-22 | staked; unstaking started |
| 23 | window closed |
| 24-28 | a never-used account checks as unused; funded; its post-quantum key registration alerted with **no classical-only false alarm**; then quantum-ready |
| 29-30 | `/history` and `/check` of the linked wallet (and the bot's health in sync at the end) |

The copied-code step used bravo's real transaction `CDFCF47ED162CA148564FA58B2E72350294993FC6918997454054C658AE4328C`, which carried alpha's pending code and landed on chain. The code stayed pending and no message was sent.

## 2. Pages with the real QoreX extension

`apps/bot/scripts/qorex-e2e.ts` drives Chromium with the unpacked QoreX 0.4.3 extension, on the production bot. All six pass:

| Page | What QoreX showed and signed | Confirmed by |
| --- | --- | --- |
| Link | MsgSend 1 uqor to yourself, memo `QoreWatch link <code>`, hybrid signature | the bot's "Wallet linked" |
| Revoke a permission | `/cosmos.authz.v1beta1.MsgRevoke`, grantee and message type | the grant is gone on chain |
| Revoke a fee allowance | `/cosmos.feegrant.v1beta1.MsgRevokeAllowance`, grantee | the allowance is gone |
| Revoke a token approval | `approve(spender, 0)` on fUSD, inside QoreX's own window | allowance 0 |
| Close a window | the page's three steps followed in QoreX's own screens | the window is closed on chain |
| Attest | `attest(score, reportHash, code)` on `QoreWatchAttest` | the bot's "matches the report" |

QoreX cannot decode the attest call ("Unknown contract call 0xf1dad6b6… QoreX cannot read what it does"). The page therefore shows the score, the report fingerprint and the contract address before the user signs.

## 3. Wallet linking

| Attempt | Result | Evidence |
| --- | --- | --- |
| Link with a classical-only signature | refused (`not_hybrid`) | `test/bot.test.ts` |
| Link with a failed transaction | refused (`failed_tx`) | `test/bot.test.ts` |
| Reuse a code that already linked | refused (single use) | `test/bot.test.ts`, `test/store.test.ts` |
| Expired code, or an attest code used to link | refused | `test/store.test.ts` |
| Copy a pending code into another account's transaction | refused (**F-1**) | `test/store.test.ts`, `test/watcher.test.ts`, live step 3 |
| Claim a code for a second address | `409`; the first claim stands | `test/server.test.ts`, live on the deployed server |
| Claim with a non-address | `400` | `test/server.test.ts` |

## 4. Telegram side

- **Group admin rules.** Only group admins can change a group's watches, settings or links (`lets only admins change a group's watches`).
- **Forgetting.** `/forget` deletes everything about a chat after confirmation, and removing the bot from a group forgets the group (`forgets a group when the bot is removed`, `forgets a chat completely`).
- **Hostile text.** Memos, labels, token names and handles are sender-controlled and end up in HTML messages. They are escaped everywhere (`escapes anything a sender controls`, `escapes everything that reaches the page`).
- **Critical alerts get through.** Pause, chat mutes, address mutes and thresholds never stop a critical alert (`respects pause, chat mutes, address mutes and money thresholds, but never for critical alerts`). Quiet hours hold info alerts only.
- **Handles.** A QoreX `@handle` is used only after both the owner's secp256k1 and the registry's Ed25519 signatures verify (`verifies a real record from the QoreX handle registry`, `refuses lies`).
- **Telegram limits.** The bot backs off on Telegram's rate limit and stops sending to chats that blocked it.

## 5. Web pages and API

- **Headers:** a Content Security Policy that allows scripts from the site only (no inline scripts), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and a restrictive `Permissions-Policy`, plus HSTS from Caddy. Tested in `sets security headers` and checked on the deployed server.
- **Under the CSP**, the landing page, a check page and the link page loaded in Chromium through the production server with zero console errors or warnings.
- **Parameters stay out of logs.** Fix and link pages take their parameters in the URL fragment (`#…`), which browsers do not send to the server.
- **Rate limit:** 120 requests a minute per client on the API (`rate-limits each client`). Behind Caddy, the client address is the one Caddy sets; Caddy drops a forged `X-Forwarded-For`.
- **Read-only:** the only write endpoint is the link claim, which can only bind an unclaimed, unexpired link code.

## 6. Deployment

On a fresh Ubuntu 24.04 server (systemd, SSH), and again on a copy of a shared server (Caddy already serving three sites from one Caddyfile, a Node 18 app holding port 8787, a global pnpm 8), following [deploy/README.md](deploy/README.md) exactly:

| Check | Result |
| --- | --- |
| `ship.sh` over SSH | only committed files travel (`git archive`); the `.env` lands mode 600 |
| Setup and first release | Node 22 and Caddy installed; healthy and in sync with the chain |
| `verify.sh` | 25 of 25: node version, unprivileged user, root-only 600 secrets, no `.env` or `private/` in the release, port 8787 on 127.0.0.1 only, every page over HTTPS, security headers, HTTP to HTTPS redirect, database, backup |
| A real alert through the deployed bot | 0.01 QOR with the note "VPS deploy test" reported within seconds |
| Broken release | backed up, failed to start, rolled back automatically |
| Reboot | everything came back by itself |
| Restore and upgrade | restore from backup worked; the schema migration upgraded the live database in place |
| Shared server | setup refused port 8787 (taken) and a domain already served, changing nothing; with `--port 8790` the only Caddyfile change was one appended import line; the other sites, the Node 18 app, the system node and pnpm were unchanged; QoreWatch ran on its own Node 22 using about 60 MB |

The systemd unit gives the bot no capabilities, a read-only system, a private `/tmp` and devices, and write access only to `/var/lib/qorewatch`. systemd reads the token file for it.

## 7. Second pass: attacking it again (20 November 2026)

The first pass proved the product works and refused the attacks we expected. The second pass asked a different question: **what could an attacker make QoreWatch believe or do that its owner never intended?** It attacked commit `2f7d588` with working exploits, written as tests in `apps/bot/test/security/`, against the real code: the fake Telegram Bot API, the real HTTP app and recorded testnet transactions. Nothing was sent to the deployed site, the live bot or QoreChain. It started where a takeover would start: how the bot decides who signed a transaction, codes that are shown to more than one person, and the promises the README and the bot make ("so I know this address is yours", "the code works once, only for the address you connect").

| Area | Attacks tried | Result | Evidence |
| --- | --- | --- | --- |
| Leaks | secret scan of the tree, all 56 commits and the built pages; by hand: env files, keys and databases ever committed | none (the one hit is the QoreX handle registry's **public** key) | scan output, private audit log |
| Who signed a link | fee grant from the target (`fee.granter`), a separate fee payer, a transaction without `acc_seq` | **F-8** found and fixed | `security/feegrant-link.test.ts` |
| Link codes in groups | a member claims the code an admin asked for | **F-9** found and fixed | `security/group-link.test.ts` |
| Attest codes | the code used first, from another account | **F-10** found and fixed | `security/attest-frontrun.test.ts` |
| Buttons and prompts | forged callback data for every action; a member answering an admin's waiting prompt | refused: every change re-checks the group admin; a member's message only clears the admin's prompt | review of every callback branch |
| Link API | guessing codes, lowercase codes, arrays and `__proto__` in the claim body, a link code on the attest route, a burst against the rate limit | refused; 31^8 possible codes at 120 requests a minute | exploit scripts, private audit log |
| Fix pages | a crafted `/fix/approval` link pointing at an NFT contract (same `approve` selector) | refused: the page reads `allowance` first, which an NFT does not have | page code review |
| Deploy kit | a neighbour on a shared server pre-creating the `/tmp` extraction folder and swapping it during extraction | refused: tar resets the folders to root, and the swap never won | simulation with an unprivileged user |
| Contract | access, value, events, look-alike emitters | nothing to take: no owner, no funds, only the caller's own record; the bot reads events from this contract only | review, 7 Foundry tests |

Three findings, F-8 to F-10 below. Each was first shown as a failing test, then fixed, then attacked again with variants.

## Findings

| | Severity | Finding | Fix |
| --- | --- | --- | --- |
| **F-1** | Medium | **A pending link code could be copied.** QoreChain's public RPC shows pending transactions. Someone watching it could put your link code into their own hybrid-signed transaction and get it into a block first. Your chat would then call their address "My wallet": its alerts would read as yours, and your link would fail. No funds or data were at risk. | The link page claims the code for the address QoreX connected before it signs; the bot links only that signer (`3455d9d`). Verified live with a real copied-code transaction. |
| **F-2** | Medium (availability) | **Caddy could not start after setup.** `caddy validate` ran as root and created the access-log file owned by root, so Caddy's own user could not open it. Setup still reported success. Found on the fresh-server test. | No access-log file (visitor addresses also stay off disk); validation runs as the caddy user; setup fails loudly if Caddy is not running (`d0c27ee`). |
| **F-3** | Low (test integrity) | **The QoreX test harness could pass silently.** A setup transaction that failed ended the run with exit code 0 and "2/2". | Harness errors are recorded as failures; leftover state from an interrupted run is reused; a failing step saves a screenshot (`1c7cc84`). |
| **F-4** | Low | **Slight bias in code characters.** `byte % 31` made some characters a little more likely. | Rejection sampling, with a distribution test (`3455d9d`). |
| **F-5** | Low (operations) | **A busy port crashed the bot with an unhandled error** after logging "listening". | The listening line waits for the port; a busy port exits with a clear message (`73cead9`). |
| **F-6** | Low (accuracy) | **False "classical-only signature" warning on key registration.** A key registration is classical-only by necessity. | Not flagged when the same transaction registers a post-quantum key (`8138100`); covered by a test and live step 27. |
| **F-7** | High (shared servers) | **Setup could disturb other apps on a shared server.** Any existing Caddyfile mentioning `/usr/share/caddy` was taken for the package's placeholder and replaced, which would have dropped every other site. Setup also upgraded the system Node and ran `corepack enable`, which could change the tooling of other apps. The bot's port was fixed at 8787. Raised by the deploy session before anything ran on the real server. | Only the untouched placeholder is ever replaced; otherwise a backup and one appended import line, checked by `caddy adapt` and applied with a graceful reload, and restored if refused. A domain already served is refused. QoreWatch uses its own checksum-verified Node 22 when the system one is older, and no global tool changes. The port is a choice (`--port`), checked for conflicts. The service has memory limits (`c08df1a`). Re-tested on a copy of the shared server: three existing sites, a Node 18 app on 8787 and pnpm 8 unchanged; 25 of 25 checks. |
| **F-8** | High | **Someone holding a fee allowance from an address could link that address as theirs.** The bot took the transaction's `fee_payer` for its signer; the Cosmos SDK puts the fee *granter* there when an allowance pays the fee. | The signer comes from the key that signed; a link paid through a fee grant is refused (`336d06a`, `ef98303`). Details below. |
| **F-9** | Medium | **A group member could take the group's wallet link.** `/link` is admin-only, but its code was posted to the whole group, and the first address to claim a code wins it. | In groups the code goes to the admin privately (`ab065c2`). Details below. |

Earlier, during the build, live testing also corrected the window-fix steps to match QoreX's real screens (`a310e6f`) and flagged dust-liquidity pools as thin instead of showing absurd prices (`7d013c0`).

## Second-pass findings in detail

### F-8 (High): a fee grant let its grantee link the granter's address as "owned"

**What was wrong.** To link a wallet, the owner sends a tiny transaction with a one-time code, and the bot links *the account that signed it*. The bot decided who signed by reading the `tx` event's `fee_payer` first (`packages/core/src/tx.ts`, `findSigner`). In the Cosmos SDK, that attribute names the account the fee was **taken from**, which is the fee **granter** whenever a fee allowance pays the fee, not the signer.

**How it was exploited.**
1. The victim (for example a treasury or a sponsor) has given the attacker a fee allowance, which is common for sponsored fees.
2. The attacker asks QoreWatch for a link code and, on the link page, claims it with the **victim's** address (the claim step accepts any address; the signature is meant to prove ownership).
3. The attacker signs their own hybrid (ML-DSA-87) link transaction with `fee.granter` set to the victim.
4. The bot read `fee_payer` = victim, found a valid hybrid signature, and replied: "✅ Wallet linked … QoreX signed the link with your post-quantum key, so I know this address is yours."

The exploit is the test `apps/bot/test/security/feegrant-link.test.ts`: a recorded testnet transaction re-encoded with a fee granter, with the events the SDK emits for a granted fee. Before the fix it linked the victim's address.

**Impact.** It broke the product's core promise, "a linked address is really yours". The attacker's chat would then show the victim's address as "My wallet" and could produce attestations and public `/check` cards in its name. No funds could move (QoreWatch never signs anything), which is why it is High and not Critical.

**Fix.**
- `336d06a`: the signer now comes from the ante handler's `acc_seq` (the key that signed) or the EVM sender, and `fee_payer` is never used when the transaction names a fee granter.
- `ef98303`: defence in depth. The link page always sends a plain self-transfer paid by the signer, so any link transaction that uses a fee grant is now refused (reason `fee_grant`) before the code is consumed.

**Verification.** Both tests in `feegrant-link.test.ts` were run against the code before the fixes (`2f7d588`) and failed: the signer resolved to the victim's address, and the link went through. Both pass after. 61 of the 70 recorded real testnet transactions in `packages/core/test/fixtures/tx/` carry `acc_seq`, so the signer normally comes from the key that signed; for the rest, a fee granter is never taken for the signer, and `ef98303` refuses fee-granted links outright. One assumption remains: that QoreChain fills `fee_payer` the way the upstream Cosmos SDK does. The fix doesn't depend on it.

### F-9 (Medium): a group member could take the group's wallet link

**What was wrong.** In a group, only admins may run `/link`, but the reply (the code and the link page URL) was posted to the group, where every member could read it. A code belongs to whoever claims it first on the link page.

**How it was exploited.** An admin sends `/link`. A non-admin member opens the posted link page first, connects their own wallet and approves the link transaction. The group's "My wallet" becomes the member's address: the admin-only rule is bypassed, and the group's alerts, `/check` and attestations follow the member's wallet. Test: `apps/bot/test/security/group-link.test.ts`.

**Impact.** A member could take over what a group watches and attests to, and make the group's bot vouch for their wallet. Medium: it needs group membership and acting before the admin, and no funds are at risk.

**Fix** (`ab065c2`). In a group, the code goes to the admin who asked, in a private chat; the group only hears "I sent you the link code in a private chat. Codes are never posted in groups." If the bot can't message the admin yet, it asks them to press Start first.

**Verification.** `group-link.test.ts` was run against the code before the fix (`2f7d588`) and failed: the code was in the group message, and the member's claim and link succeeded. It passes after: the group message carries no code, the code reaches only the admin's private chat, and a member's claim no longer links. A member sending `/link` themselves is still refused, as before.

## Limitations

- **Not a third-party audit,** and testnet only.
- **What never reaches a block is invisible.** QoreChain refuses some transactions at the door (for example a classical-only signature on a protected account). That refusal is the protection working, but no bot can report it.
- **A watcher outage longer than the catch-up limit** (`MAX_CATCHUP_BLOCKS`, about 70 minutes by default) skips the oldest blocks rather than replaying days. `/status` and `/healthz` show the lag.
- **`/healthz` is public.** It shows the block height and the last chain error, never a secret.
- **The rate limit is in memory** and per process, which suits one server.
- **QoreWatch trusts the public QoreChain endpoints** it reads (or the ones set in `QORE_*_URL`). A lying node could fake or hide alerts; running your own node removes that trust.
- **The attest call is opaque in QoreX,** so users rely on the page's summary of what they sign. The contract only records data from the signer's own account and holds no funds.
