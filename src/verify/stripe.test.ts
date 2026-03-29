import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { StripeVerifier } from "./stripe.js";

/** Computes a valid Stripe webhook signature for testing. */
function computeStripeSignature(
  secret: string,
  timestamp: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

describe("StripeVerifier", () => {
  it("accepts a valid signature", () => {
    const secret = "whsec_test";
    const body = '{"type":"charge.succeeded"}';
    const ts = "1616161616";
    const sig = computeStripeSignature(secret, ts, body);

    const verifier = new StripeVerifier(secret);
    const headers = {
      "stripe-signature": `t=${ts},v1=${sig}`,
    };

    const result = verifier.verify(Buffer.from(body), headers);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const secret = "whsec_test";
    const body = '{"type":"charge.succeeded"}';
    const ts = "1616161616";
    const wrongSig = computeStripeSignature("wrong-secret", ts, body);

    const verifier = new StripeVerifier(secret);
    const headers = {
      "stripe-signature": `t=${ts},v1=${wrongSig}`,
    };

    const result = verifier.verify(Buffer.from(body), headers);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("returns error for missing header", () => {
    const verifier = new StripeVerifier("whsec_test");
    const result = verifier.verify(Buffer.from("{}"), {});

    expect(result.error).toBeDefined();
    expect(result.valid).toBe(false);
  });

  it("returns error for malformed headers", () => {
    const verifier = new StripeVerifier("whsec_test");

    const cases = [
      { name: "garbage", header: "not-a-valid-header" },
      { name: "no timestamp", header: "v1=abc123" },
      { name: "no v1 sig", header: "t=1616161616" },
    ];

    for (const tc of cases) {
      const headers = { "stripe-signature": tc.header };
      const result = verifier.verify(Buffer.from("{}"), headers);
      expect(result.error).toBeDefined();
    }
  });

  it("accepts when one of multiple v1 signatures matches", () => {
    const secret = "whsec_test";
    const body = '{"type":"charge.succeeded"}';
    const ts = "1616161616";
    const goodSig = computeStripeSignature(secret, ts, body);
    const badSig = "deadbeef";

    const verifier = new StripeVerifier(secret);
    const headers = {
      "stripe-signature": `t=${ts},v1=${badSig},v1=${goodSig}`,
    };

    const result = verifier.verify(Buffer.from(body), headers);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});
