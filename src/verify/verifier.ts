import type { IncomingHttpHeaders } from "node:http";
import { GitHubVerifier } from "./github.js";
import { StripeVerifier } from "./stripe.js";

/**
 * SignatureVerifier verifies webhook signatures.
 * Returns [valid, error] — error indicates a structural problem (missing header),
 * while valid=false with no error means the signature simply didn't match.
 */
export interface SignatureVerifier {
  verify(
    body: Buffer,
    headers: IncomingHttpHeaders
  ): { valid: boolean; error?: string };
}

/**
 * Creates a SignatureVerifier for the given provider type and secret.
 */
export function createVerifier(
  type: string,
  secret: string
): SignatureVerifier {
  switch (type) {
    case "github":
      return new GitHubVerifier(secret);
    case "stripe":
      return new StripeVerifier(secret);
    default:
      throw new Error(`unknown verifier type: ${type}`);
  }
}
