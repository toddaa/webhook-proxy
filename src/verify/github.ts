import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { SignatureVerifier } from "./verifier.js";

/**
 * GitHubVerifier verifies GitHub webhook signatures using HMAC-SHA256.
 * Reads the X-Hub-Signature-256 header which has format: sha256=<hex>
 */
export class GitHubVerifier implements SignatureVerifier {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  verify(
    body: Buffer,
    headers: IncomingHttpHeaders
  ): { valid: boolean; error?: string } {
    const sig = headers["x-hub-signature-256"] as string | undefined;
    if (!sig) {
      return { valid: false, error: "missing X-Hub-Signature-256 header" };
    }

    if (!sig.startsWith("sha256=")) {
      return {
        valid: false,
        error:
          "malformed X-Hub-Signature-256 header: missing sha256= prefix",
      };
    }

    const receivedHex = sig.slice("sha256=".length);

    // Validate hex string
    let received: Buffer;
    try {
      received = Buffer.from(receivedHex, "hex");
      // Buffer.from doesn't throw on invalid hex, it just ignores bad chars.
      // Verify the round-trip to catch malformed hex.
      if (received.toString("hex") !== receivedHex.toLowerCase()) {
        return {
          valid: false,
          error:
            "malformed X-Hub-Signature-256 header: invalid hex",
        };
      }
    } catch {
      return {
        valid: false,
        error:
          "malformed X-Hub-Signature-256 header: invalid hex",
      };
    }

    const expected = createHmac("sha256", this.secret).update(body).digest();

    // Use timing-safe comparison to prevent timing attacks
    if (expected.length !== received.length) {
      return { valid: false };
    }

    return { valid: timingSafeEqual(expected, received) };
  }
}
