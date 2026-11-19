import { Http } from "./http.js";
import type { AbciTxResult, RawTx } from "./tx.js";

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string; data?: string };
}

/** CometBFT RPC reads: status, blocks, block results, transaction search. */
export class Rpc {
  constructor(
    readonly url: string,
    private readonly http = new Http(),
  ) {}

  private async call<T>(path: string): Promise<T> {
    const r = await this.http.json<RpcEnvelope<T>>(this.url + path);
    if (r.error) throw new Error(`RPC ${path.split("?")[0]}: ${r.error.message}${r.error.data ? ` (${r.error.data})` : ""}`);
    return r.result as T;
  }

  /** Latest block height and time, and whether the node is still syncing. */
  async status(): Promise<{ height: number; time: string; catchingUp: boolean; chainId: string }> {
    const s = await this.call<{ node_info: { network: string }; sync_info: { latest_block_height: string; latest_block_time: string; catching_up: boolean } }>("/status");
    return { height: Number(s.sync_info.latest_block_height), time: s.sync_info.latest_block_time, catchingUp: s.sync_info.catching_up, chainId: s.node_info.network };
  }

  /** All transactions in one block, with their results and the block time. */
  async blockTxs(height: number): Promise<{ height: number; time: string; txs: RawTx[] }> {
    const [b, r] = await Promise.all([
      this.call<{ block: { header: { time: string; height: string }; data: { txs: string[] | null } } }>(`/block?height=${height}`),
      this.call<{ txs_results: AbciTxResult[] | null }>(`/block_results?height=${height}`),
    ]);
    const time = b.block.header.time;
    const txs = (b.block.data.txs ?? []).map((tx, i) => ({ tx, result: r.txs_results?.[i] ?? { code: 0, events: [] }, height, time, index: i }));
    return { height, time, txs };
  }

  /** Block header time only. */
  async blockTime(height: number): Promise<string> {
    const b = await this.call<{ block: { header: { time: string } } }>(`/block?height=${height}`);
    return b.block.header.time;
  }

  /** One transaction by Cosmos hash (hex, no 0x). Undefined if the node does not know it. */
  async tx(hash: string): Promise<RawTx | undefined> {
    try {
      const t = await this.call<{ hash: string; height: string; index: number; tx: string; tx_result: AbciTxResult }>(`/tx?hash=0x${hash.replace(/^0x/i, "")}`);
      return { tx: t.tx, result: t.tx_result, height: t.height, time: await this.blockTime(Number(t.height)), index: t.index, hash: t.hash };
    } catch (e) {
      if (/not found/i.test(String((e as Error).message))) return undefined;
      throw e;
    }
  }

  /** Search transactions by event query, newest first. */
  async search(query: string, perPage = 20, page = 1): Promise<{ total: number; txs: RawTx[] }> {
    const q = encodeURIComponent(`"${query}"`);
    const r = await this.call<{ total_count: string; txs: { hash: string; height: string; index: number; tx: string; tx_result: AbciTxResult }[] }>(
      `/tx_search?query=${q}&per_page=${perPage}&page=${page}&order_by=%22desc%22`,
    );
    const heights = [...new Set(r.txs.map((t) => Number(t.height)))];
    const times = new Map(await Promise.all(heights.map(async (h) => [h, await this.blockTime(h)] as const)));
    return {
      total: Number(r.total_count),
      txs: r.txs.map((t) => ({ tx: t.tx, result: t.tx_result, height: t.height, time: times.get(Number(t.height))!, index: t.index, hash: t.hash })),
    };
  }

  /**
   * The most recent transactions that involve an address: sent by it (any message),
   * or moving money to it. Deduplicated, newest first.
   */
  async recentForAddress(address: string, limit = 5): Promise<RawTx[]> {
    const [sent, received] = await Promise.all([this.search(`message.sender='${address}'`, limit), this.search(`transfer.recipient='${address}'`, limit)]);
    const byHash = new Map<string, RawTx>();
    for (const t of [...sent.txs, ...received.txs]) byHash.set(t.hash!, t);
    return [...byHash.values()].sort((a, b) => Number(b.height) - Number(a.height) || (b.index ?? 0) - (a.index ?? 0)).slice(0, limit);
  }
}
