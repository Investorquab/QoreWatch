# QoreWatch contracts: QoreWatchAttest

`QoreWatchAttest` lets an account record its QoreWatch post-quantum check on QoreChain, from its own account: the score, a report hash (`reportHash`: the SHA3-256 of the canonical report) and the one-time code the bot issued. The bot then confirms in Telegram that what landed on chain matches the report it gave. It holds no funds and stores data only for `msg.sender`.

| | |
| --- | --- |
| Contract | `src/QoreWatchAttest.sol`: `attest(uint16 score, bytes32 reportHash, bytes8 code)`, event `Attested`, `attestationOf(account)` |
| Tests | `test/QoreWatchAttest.t.sol` (Foundry, 7 tests): `forge test` |
| Deployed (testnet) | `0x52f29cb4f18ec44acbb997b94c0776e4e35ed273`, block 10389715, deploy tx `0x14a8b49efa151586fd80ee234ceb3e981673c97679a3b6e3b7c97dd2b6967400`; see `deployments/qorechain-diana.json` |
| Deploy | `script/deploy.ts` (`pnpm deploy:testnet`), after opening an EVM window with `pnpm window open` |

## Scaffolded with create-qorechain-dapp

This workspace was created from the **Foundry template of [`create-qorechain-dapp`](https://www.npmjs.com/package/create-qorechain-dapp)** (commit `d71ca3b`, "Scaffold contracts from create-qorechain-dapp's foundry template"). From the template, QoreWatch keeps `foundry.toml` (the `qorechain_testnet` RPC), `tsconfig.json`, `.env.example`, and the EVM window helper `scripts/window.ts` (`pnpm window status | register | open`), which was used to register the deployer's ML-DSA-87 key and open the hybrid-signed EVM window for the testnet deploy (window tx `FE119A8198DF0203A457FAA87E42570C982A9283070F07A96759603C8B6CC710`). The template's example `Counter` contract, script and test were replaced by `QoreWatchAttest`, `script/deploy.ts` and its tests. The template's guide to Foundry on QoreChain follows, unchanged except for the file list.

| Network | EVM chain id | RPC (named in `foundry.toml`) |
| --- | --- | --- |
| Testnet (`qorechain-diana`) | 9800 | `qorechain_testnet` = `https://evm-testnet.qore.host` |
| Mainnet (`qorechain-vladi`) | 9801 | `qorechain` = `https://evm.qore.host` |

## Prerequisites

- Foundry (`forge`), installed with `foundryup`.
- Node.js 20 or later and a package manager, for the window helper.
- A funded account on the network you deploy to.

## Setup

```sh
pnpm install          # the window helper's dependencies
pnpm forge-std        # forge install foundry-rs/forge-std --no-git
cp .env.example .env  # the scaffolder already did this
```

Put the deployer's key in `.env` (`PRIVATE_KEY`). Never commit `.env`.

## Build and test

```sh
forge build
forge test
```

Tests run on Foundry's local EVM and need no network.

## Before you deploy: open an EVM window

QoreChain admits an EVM transaction only when the sender has:

1. a registered **ML-DSA-87** key, and
2. a live **EVM authorisation window**.

Both are set up on QoreChain's native lane with messages signed with the
post-quantum key, so the secp256k1 key in `PRIVATE_KEY` can never authorise
spending on its own. A deploy from an account without them is refused, so do
this first:

```sh
pnpm window status     # account, PQC key, window
pnpm window register   # once per account: registers its ML-DSA-87 key
pnpm window open       # opens a window: 600 blocks, 5 transactions
```

With `QORE_MNEMONIC` set, the helper derives the account and its ML-DSA-87 key
from the mnemonic. Otherwise it uses `PRIVATE_KEY` for the account and a PQC
recovery code, `QORE_PQC_RECOVERY_CODE`, for the ML-DSA-87 key; it stops with a
message if the code is missing. Create a code once and put it in `.env`:

```sh
pnpm window recovery-code   # prints a new QRC1 code (generatePqcRecoveryCode)
```

Keep a copy of the code apart from the private key and keep using the same
one: a different code gives the account a different ML-DSA-87 key. If the
account already has a key registered by another wallet, open the window from
that wallet instead. An account registered with this helper before SDK 0.13.0
has a different key registered; `pnpm window status` then shows
"registered, but NOT this key". Rotate it to the recovery-code key with
`rotatePqcKeyMsg` (MsgRotatePQCKey), loading the old key with
`unifiedAccountFromSeed(seed, { legacySeedDerivation: true })` (see the
`@qorechain/sdk` README).

What to know about the window:

- It bounds the number of blocks, the number of EVM transactions, and the total
  they may spend: value **plus** the maximum fee (gas limit x fee cap) of each
  transaction. Foundry sets the fee cap near twice the base fee (a dry run on
  the testnet priced a deploy at 200 gwei), so `pnpm window open` sizes the
  window for transactions of up to 3,000,000 gas at 250 gwei. Set
  `QORE_WINDOW_MAX_UQOR` to choose the total yourself.
- `blocks` is a block count, not a duration.
- Opening a window is a native-lane transaction, and it **advances the
  account's nonce**. Open the window first, then deploy; Foundry reads the
  nonce when it broadcasts.
- Opening replaces any earlier window.

## Deploy

```sh
pnpm window open
pnpm deploy:testnet
```

`script/deploy.ts` builds with Foundry, deploys `QoreWatchAttest` from the account in `.env` (never commit `.env`) and writes `deployments/qorechain-diana.json`.

Fees: on both networks today `eth_gasPrice` answers 112.5 gwei (a 100 gwei
base fee plus a 12.5 gwei priority fee). Foundry's defaults pick this up.

Contract verification: Sourcify does not list chain ids 9800 and 9801 yet.

## Project layout

```
src/QoreWatchAttest.sol           the contract
test/QoreWatchAttest.t.sol        Foundry tests
script/deploy.ts                  the deploy script (pnpm deploy:testnet)
deployments/qorechain-diana.json  where it is deployed
scripts/window.ts                 the EVM window helper from the template (pnpm window)
foundry.toml              compiler settings and the named RPC endpoints
```
