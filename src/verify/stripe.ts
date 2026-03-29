import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { SignatureVerifier } from "./verifier.js";

/**
 * StripeVerifier verifies Stripe webhook signatures using HMAC-SHA256.
 * The Stripe-Signature header format is: t=<timestamp>,v1=<sig>[,v1=<sig>...]
 * The signed payload is "<timestamp>.<body>".
 *
 * TODO: Add timestamp tolerance check (e.g., 300s) to prevent replay attacks
 * when verification becomes a gatekeeper (rejecting invalid requests).
 */
export class StripeVerifier implements SignatureVerifier {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  verify(
    body: Buffer,
    headers: IncomingHttpHeaders
  ): { valid: boolean; error?: string } {
    const sig = headers["stripe-signature"] as string | undefined;
    if (!sig) {
      return { valid: false, error: "missing Stripe-Signature header" };
    }

    let timestamp = "";
    const v1Sigs: string[] = [];

    // Parse "t=<ts>,v1=<sig>,v1=<sig>,..." format
    const parts = sig.split(",");
    for (const part of parts) {
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) continue;
      const key = part.slice(0, eqIndex);
      const value = part.slice(eqIndex + 1);
      if (key === "t") {
        timestamp = value;
      } else if (key === "v1") {
        v1Sigs.push(value);
      }
    }

    if (timestamp === "") {
      return {
        valid: false,
        error: "malformed Stripe-Signature header: missing timestamp",
      };
    }
    if (v1Sigs.length === 0) {
      return {
        valid: false,
        error: "malformed Stripe-Signature header: no v1 signatures",
      };
    }

    // Compute expected signature: HMAC-SHA256 of "<timestamp>.<body>"
    const expected = createHmac("sha256", this.secret)
      .update(timestamp)
      .update(".")
      .update(body)
      .digest();

    // Check each v1 signature — any match is sufficient
    for (const s of v1Sigs) {
      let received: Buffer;
      try {
        received = Buffer.from(s, "hex");
        // Skip malformed individual signatures
        if (received.toString("hex") !== s.toLowerCase()) continue;
      } catch {
        continue;
      }

      if (
        expected.length === received.length &&
        timingSafeEqual(expected, received)
      ) {
        return { valid: true };
      }
    }

    return { valid: false };
  }
}
