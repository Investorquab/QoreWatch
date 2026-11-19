import { getNetwork } from "@qorechain/sdk";

/** Everything QoreWatch needs to read one QoreChain network. */
export interface ChainConfig {
  /** "testnet" or "mainnet". */
  name: "testnet" | "mainnet";
  /** Native chain id, e.g. qorechain-diana. */
  chainId: string;
  /** EVM chain id (9800 testnet, 9801 mainnet). */
  evmChainId: number;
  /** CometBFT RPC: blocks, block results, tx search. */
  rpc: string;
  /** REST (LCD): account state. */
  rest: string;
  /** EVM JSON-RPC: logs, tokens, precompiles. */
  evmRpc: string;
  /** Block explorer for links. */
  explorer: string;
  /** Average block time in seconds, for "in about N minutes" estimates. */
  blockSeconds: number;
  /** Largest block span the public EVM node accepts in one eth_getLogs call. */
  maxLogRange: number;
}

const EVM_CHAIN_IDS = { testnet: 9800, mainnet: 9801 } as const;

/** The public endpoints for a network, with optional overrides (e.g. your own node). */
export function chainConfig(
  name: "testnet" | "mainnet" = "testnet",
  overrides: Partial<Pick<ChainConfig, "rpc" | "rest" | "evmRpc" | "explorer" | "blockSeconds">> = {},
): ChainConfig {
  const n = getNetwork(name);
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim().replace(/\/+$/, "") : undefined);
  return {
    name,
    chainId: n.chainId,
    evmChainId: EVM_CHAIN_IDS[name],
    rpc: clean(overrides.rpc) ?? n.endpoints.rpc,
    rest: clean(overrides.rest) ?? n.endpoints.rest,
    evmRpc: clean(overrides.evmRpc) ?? n.endpoints.evmRpc,
    explorer: clean(overrides.explorer) ?? "https://explore.qore.network",
    blockSeconds: overrides.blockSeconds ?? 1.42,
    maxLogRange: 10_000,
  };
}
