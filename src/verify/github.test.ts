import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { GitHubVerifier } from "./github.js";

/** Computes a valid GitHub webhook signature for testing. */
function computeGitHubSignature(secret: string, body: string): string {
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${mac}`;
}

describe("GitHubVerifier", () => {
  it("accepts a valid signature", () => {
    const secret = "test-secret";
    const body = '{"action":"push"}';
    const sig = computeGitHubSignature(secret, body);

    const verifier = new GitHubVerifier(secret);
    const headers = { "x-hub-signature-256": sig };

    const result = verifier.verify(Buffer.from(body), headers);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const secret = "test-secret";
    const body = '{"action":"push"}';
    const wrongSig = computeGitHubSignature("wrong-secret", body);

    const verifier = new GitHubVerifier(secret);
    const headers = { "x-hub-signature-256": wrongSig };

    const result = verifier.verify(Buffer.from(body), headers);
    expect(result.error).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("returns error for missing header", () => {
    const verifier = new GitHubVerifier("test-secret");
    const result = verifier.verify(Buffer.from("{}"), {});

    expect(result.error).toBeDefined();
    expect(result.valid).toBe(false);
  });
});
