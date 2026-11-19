// Record specific transactions by hash: node scripts/record-hashes.mjs <name> <hash>...
import { writeFileSync } from "node:fs";
const RPC = "https://rpc-testnet.qore.host";
const get = async (p) => (await (await fetch(RPC + p, { headers: { "user-agent": "qorewatch-fixtures" } })).json()).result;
const [name, ...hashes] = process.argv.slice(2);
const out = [];
for (const h of hashes) {
  const t = await get(`/tx?hash=0x${h}`);
  t.time = (await get(`/block?height=${t.height}`)).block.header.time;
  out.push(t);
}
writeFileSync(new URL(`../test/fixtures/tx/${name}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(name, out.length);
