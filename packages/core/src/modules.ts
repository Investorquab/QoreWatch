import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";

/** Cosmos module accounts are sha256(name)[0..20]. Their friendly names, for alerts. */
const MODULES: Record<string, string> = {
  fee_collector: "the network fee collector",
  evm: "the EVM module",
  distribution: "the staking rewards module",
  bonded_tokens_pool: "the staking pool",
  not_bonded_tokens_pool: "the unbonding pool",
  gov: "governance",
  mint: "the mint module",
  erc20: "the token bridge module",
  amm: "the AMM (swap pools)",
  burn: "the burn module",
  crossvm: "the cross-VM module",
  feemarket: "the fee market",
  transfer: "the IBC transfer module",
  stakingtier: "the staking tier module",
  abstractaccount: "the smart-account module",
  pqc: "the PQC module",
  rdk: "the rollup module",
  bridge: "the bridge module",
  lightnode: "the light-node module",
};

const byAddress = new Map<string, { name: string; label: string }>();
for (const [name, label] of Object.entries(MODULES)) {
  const addr = bech32.encode("qor", bech32.toWords(createHash("sha256").update(name).digest().subarray(0, 20)));
  byAddress.set(addr, { name, label });
}

/** The module behind an address, if it is a module account. */
export function moduleAccount(address: string): { name: string; label: string } | undefined {
  return byAddress.get(address);
}

export const FEE_COLLECTOR = [...byAddress].find(([, m]) => m.name === "fee_collector")![0];
export const EVM_MODULE = [...byAddress].find(([, m]) => m.name === "evm")![0];
