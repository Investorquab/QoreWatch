# How AI was used to build QoreWatch

QoreWatch was built by one developer working with **Claude Code** (Anthropic's coding agent) in a cloud session. This file says plainly who did what, so judges and users can weigh the work.

## The split

**The developer decided:**

- the product: a Telegram alert bot for QoreChain wallets, for the Quantum Pass track, with the first feature list (money moves, post-quantum key changes, spending windows, permissions) and the rule that the bot must be a standard, complete product rather than a demo;
- that feasibility comes first: every feature was tested against the live testnet before the build started, and the name was chosen only after that;
- the name and the bot, @qorewatchbot, created by the developer in BotFather;
- ten working rules: build and test everything before it counts as done; a professional repository with many small commits and nothing private in it; a strict deploy-only handoff; deployment tested before anything is pushed; a premium landing page;
- hosting on their own VPS, the funding of the test accounts, and every push to GitHub.

**Claude Code did, under those rules:**

- **Feasibility.** Checked each proposed feature against the live chain and QoreX 0.4.3. Results shaped the design: which events QoreChain indexes, that failed transactions drop their events (so the watcher decodes transaction bodies), what QoreX lets a website request (revokes and sends) and what it keeps to itself (closing windows, session keys, key registration).
- **Core library.** Wrote the chain readers, a decoder for every QoreChain message type, the plain-language explanations and the health check, with tests against real recorded transactions.
- **Bot.** Wrote the storage, the 22 commands, the watcher, the detectors, the scheduled jobs, the share cards and the HTTP server. Tested them against a stand-in for the Telegram Bot API and a stand-in chain.
- **Pages and contract.** Wrote the link, check, transaction, fix and attest pages, and the `QoreWatchAttest` contract with Foundry tests. Deployed the contract to testnet from a fresh test account.
- **Live testing.** Ran every alert on the real testnet with funded test accounts, and drove the real QoreX extension through every page with Playwright.
- **Landing page.** Built it with the Taste design skill as a working reference (its layout dealer, copy linter, checker and finish gate, run at 1440, 1024, 820, 768 and 390 pixels).
- **Deploy kit.** Wrote the systemd units, the Caddy site and the release scripts. Tested them on a fresh Ubuntu 24.04 server in a container: install, a real alert, a broken release rolled back, a reboot, a restore and an upgrade.
- **Breaking it.** Audited the linking flow, the pages and the server. Found and fixed six problems ([audit.md](audit.md)), including a copied-link-code race that was then tested live with a real transaction.

## How the AI's work was checked

- Nothing counted as done without evidence: a passing test, an on-chain transaction, a message the bot really sent, a screenshot or a server check. [audit.md](audit.md) keeps the failures as well as the passes.
- Every commit passed `pnpm check` (lint, types, all tests, production build) first.
- Claims in the README, on the landing page and in the bot's own texts were checked against the code and the chain. The alert examples are real outputs from the live runs.
- The developer reviewed progress at each milestone and set the direction: the feature list, the rules, the hosting and the account choices.

## What AI did not do

- It held no keys of value. The test accounts are testnet-only; their recovery phrases were generated in the session's scratch space, never printed, and never committed.
- It never saw the bot's real Telegram token. Every test used a local stand-in for the Telegram API with a fake token.
- It did not connect to the developer's VPS or push to GitHub. Deployment is handed over with deploy-only instructions, and the push comes after the deployment is confirmed.
