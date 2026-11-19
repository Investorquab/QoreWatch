import { describe, expect, it } from "vitest";
import { classify, evmToQor, findLookups, isAccount, isQorAddress, qorToEvm, shortAddress, toQor } from "../src/address.js";
import { erc20FromDenom, formatUnits, parseCoins, parseUnits } from "../src/amount.js";
import { FEE_COLLECTOR, EVM_MODULE, moduleAccount } from "../src/modules.js";

const QOR = "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7";
const EVM = "0x35750cc522969f297f421e411e0cb4493572b1a8";

describe("addresses", () => {
  it("converts between qor1 and 0x for the same account", () => {
    expect(evmToQor(EVM)).toBe(QOR);
    expect(qorToEvm(QOR)).toBe(EVM);
    expect(evmToQor("0x35750cc522969F297F421E411e0Cb4493572b1a8")).toBe(QOR);
  });

  it("validates addresses and contract addresses", () => {
    expect(isQorAddress(QOR)).toBe(true);
    expect(isQorAddress("qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq8")).toBe(false); // bad checksum
    expect(isQorAddress("cosmos1x46se3fzj60jjl6zreq3ur95fy6h9vdgrhq5zf")).toBe(false);
    const contract = "qor1gs8mnq0mzulqu602n84yqu5tyqkrusm3l8a3j4rdtnv2fqhjkzeq3pytr0";
    expect(isQorAddress(contract)).toBe(true);
    expect(isAccount(contract)).toBe(false);
    expect(toQor(`  ${QOR.toUpperCase()} `)).toBe(QOR);
    expect(toQor("hello")).toBeUndefined();
  });

  it("classifies user input", () => {
    expect(classify(QOR)).toMatchObject({ kind: "address", qor: QOR, evm: EVM });
    expect(classify(EVM)).toMatchObject({ kind: "address", qor: QOR });
    expect(classify("ABD4D48E4CF3E3CDFA9019D6A0B92D3D5D8F6641438CE6AA7378356277FF4002")).toMatchObject({ kind: "tx", evm: false });
    expect(classify("0xb18cdc18fe8e8500a43dbdccb43d0a24e451193a01296a389de1cea548a1c90c")).toMatchObject({ kind: "tx", evm: true });
    expect(classify("@maria_01")).toMatchObject({ kind: "handle", handle: "maria_01" });
    expect(classify("maria")).toMatchObject({ kind: "unknown" });
  });

  it("finds every address and hash in a forwarded message, once each", () => {
    const text = `Pay ${QOR} or ${EVM} (same) — tx abd4d48e4cf3e3cdfa9019d6a0b92d3d5d8f6641438ce6aa7378356277ff4002 cc @maria_01`;
    const found = findLookups(text);
    expect(found.map((l) => l.kind)).toEqual(["address", "tx", "handle"]);
  });

  it("shortens addresses", () => {
    expect(shortAddress(QOR)).toBe("qor1x46s…5yq7");
  });

  it("knows module accounts seen on chain", () => {
    expect(FEE_COLLECTOR).toBe("qor17xpfvakm2amg962yls6f84z3kell8c5lyj5r7l");
    expect(EVM_MODULE).toBe("qor1vqu8rska6swzdmnhf90zuv0xmelej4lqeejhp2");
    expect(moduleAccount("qor1xxs9c4mfqzya8yt38pphxl4zuut67fllcw740z")?.name).toBe("amm");
    expect(moduleAccount(QOR)).toBeUndefined();
  });
});

describe("amounts", () => {
  it("formats base units", () => {
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(1_234_567_000_000n, 6)).toBe("1,234,567");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(1n, 18)).toBe("<0.000001");
    expect(formatUnits(-2_000_000n, 6)).toBe("-2");
    expect(formatUnits(0n, 6)).toBe("0");
  });

  it("parses decimal input", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("1,000", 6)).toBe(1_000_000_000n);
    expect(() => parseUnits("1.0000001", 6)).toThrow();
    expect(() => parseUnits("abc", 6)).toThrow();
  });

  it("parses event coin strings", () => {
    expect(parseCoins("11000000erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA,250000990uqor")).toEqual([
      { amount: 11_000_000n, denom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA" },
      { amount: 250_000_990n, denom: "uqor" },
    ]);
    expect(parseCoins("")).toEqual([]);
    expect(erc20FromDenom("erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA")).toBe("0x97143b771d34ddb9130b807b135ae675a5a963ca");
    expect(erc20FromDenom("uqor")).toBeUndefined();
  });
});
