import { readFileSync } from "node:fs";
import { buildTx, type TxRecord } from "../src/tx.js";

interface FixtureTx {
  hash: string;
  height: string;
  index: number;
  tx: string;
  time: string;
  tx_result: { code: number; codespace?: string; log?: string; events: { type: string; attributes: { key: string; value: string }[] }[] };
}

/** Load a recorded testnet fixture (test/fixtures/tx/<name>.json). */
export function fixture(name: string): FixtureTx[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/tx/${name}.json`, import.meta.url), "utf8")) as FixtureTx[];
}

/** Build TxRecords from a fixture file. */
export async function records(name: string): Promise<TxRecord[]> {
  return Promise.all(fixture(name).map((t) => buildTx({ tx: t.tx, result: t.tx_result, height: t.height, time: t.time, index: t.index, hash: t.hash })));
}
