import { chainConfig, Evm, Handles, Http, Rest, Rpc, Tokens, type ChainConfig } from "@qorewatch/core";
import type { Config } from "./config.js";

/** Every chain reader the bot uses, built once from the config. */
export interface Chain {
  cfg: ChainConfig;
  rpc: Rpc;
  rest: Rest;
  evm: Evm;
  tokens: Tokens;
  handles: Handles;
}

export function createChain(config: Pick<Config, "network" | "rpcUrl" | "restUrl" | "evmRpcUrl">): Chain {
  const cfg = chainConfig(config.network, { ...(config.rpcUrl ? { rpc: config.rpcUrl } : {}), ...(config.restUrl ? { rest: config.restUrl } : {}), ...(config.evmRpcUrl ? { evmRpc: config.evmRpcUrl } : {}) });
  const http = new Http({ concurrency: 6 });
  return {
    cfg,
    rpc: new Rpc(cfg.rpc, http),
    rest: new Rest(cfg.rest, http),
    evm: new Evm(cfg.evmRpc),
    tokens: Tokens.fromRpc(cfg.evmRpc),
    handles: new Handles(new Http({ concurrency: 2 })),
  };
}
