import { describe, expect, it } from "vitest";
import { assess, type HealthInput } from "../src/health.js";

const base: HealthInput = {
  address: "qor1x46se3fzj60jjl6zreq3ur95fy6h9vdgrw5yq7",
  pqc: { found: true, algorithm: "dilithium5", keyType: "hybrid", createdAtHeight: 10, possessionProven: true, migrating: false },
  auth: { exists: true, classicalKeyExposed: true, sequence: 5 },
  window: { found: false, live: false, allowedTargets: [] },
  grants: [],
  feeAllowances: [],
  kem: { found: false },
  balances: [{ denom: "uqor", amount: 5_000_000n }],
  now: new Date("2026-11-19T12:00:00Z"),
};

describe("account health", () => {
  it("is quantum-ready with a key and nothing open", () => {
    const r = assess(base);
    expect(r.status).toBe("ready");
    expect(r.score).toBe(100);
  });

  it("is at risk with no post-quantum key, worse once the classical key is public", () => {
    const hidden = assess({ ...base, pqc: { found: false }, auth: { exists: true, classicalKeyExposed: false, sequence: 0 } });
    const shown = assess({ ...base, pqc: { found: false } });
    expect(hidden.status).toBe("at_risk");
    expect(shown.status).toBe("at_risk");
    expect(shown.score).toBeLessThan(hidden.score);
    expect(shown.findings[0]!.fix).toEqual({ kind: "qorex_register_key" });
  });

  it("flags an open window to any recipient more than one limited to contracts", () => {
    const w = { found: true, live: true, remainingTxs: 4, remainingValueUqor: 20_000_000n, remainingBlocks: 600, allowedTargets: [] };
    const any = assess({ ...base, window: w });
    const scoped = assess({ ...base, window: { ...w, allowedTargets: ["0xd837298637f4459a3981b540d5543a4423add801"] } });
    expect(any.status).toBe("attention");
    expect(any.score).toBeLessThan(scoped.score);
    expect(any.findings[0]!.fix).toEqual({ kind: "qorex_close_window" });
  });

  it("counts live permission grants and ignores expired ones, with a revoke fix", () => {
    const g = { granter: base.address, grantee: "qor1kkkytv23u0aagmyp5m6h27r9wlxan0hj5q7w5c", authorization: { "@type": "/cosmos.authz.v1beta1.GenericAuthorization", msg: "/cosmos.bank.v1beta1.MsgSend" }, msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend" };
    const live = assess({ ...base, grants: [{ ...g, expiration: "2027-01-01T00:00:00Z" }] });
    expect(live.findings.find((f) => f.id.startsWith("authz:"))?.fix).toEqual({ kind: "revoke_authz", grantee: g.grantee, msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend" });
    const expired = assess({ ...base, grants: [{ ...g, expiration: "2026-01-01T00:00:00Z" }] });
    expect(expired.findings.some((f) => f.id.startsWith("authz:"))).toBe(false);
  });

  it("caps penalties so many small grants cannot zero the score alone", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ granter: base.address, grantee: `qor1grantee${i}`, authorization: { "@type": "/cosmos.authz.v1beta1.GenericAuthorization" } }));
    const r = assess({ ...base, grants: many });
    expect(r.score).toBe(70);
  });

  it("reports an unused address as such", () => {
    const r = assess({ ...base, pqc: { found: false }, auth: { exists: false, classicalKeyExposed: false, sequence: 0 }, balances: [] });
    expect(r.status).toBe("unused");
  });

  it("warns about a key migration in progress", () => {
    const r = assess({ ...base, pqc: { ...base.pqc, migrating: true } });
    expect(r.findings[0]!.id).toBe("migrating");
    expect(r.status).toBe("attention");
  });
});
