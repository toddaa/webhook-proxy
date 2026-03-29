module WebhookProxy.Tests.VerifyTests

open System
open System.Security.Cryptography
open System.Text
open Xunit
open Microsoft.AspNetCore.Http
open WebhookProxy

/// Compute a GitHub-style HMAC-SHA256 signature: sha256=<hex>
let computeGitHubSignature (secret: string) (body: string) : string =
    use hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret))
    let hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(body))
    "sha256=" + Convert.ToHexStringLower(hash)

/// Compute a Stripe-style HMAC-SHA256 signature (just the hex part).
let computeStripeSignature (secret: string) (timestamp: string) (body: string) : string =
    use hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret))
    let payload = Encoding.UTF8.GetBytes(timestamp + "." + body)
    let hash = hmac.ComputeHash(payload)
    Convert.ToHexStringLower(hash)

/// Create an IHeaderDictionary from a list of key-value pairs.
let makeHeaders (pairs: (string * string) list) : IHeaderDictionary =
    let headers = HeaderDictionary()
    for (k, v) in pairs do
        headers.[k] <- Microsoft.Extensions.Primitives.StringValues(v)
    headers :> IHeaderDictionary

// --- GitHub Verifier Tests ---

[<Fact>]
let ``GitHub verify valid signature`` () =
    let secret = "test-secret"
    let body = """{"action":"push"}"""
    let sig = computeGitHubSignature secret body
    let verifier = Verify.createGitHubVerifier secret
    let headers = makeHeaders [ "X-Hub-Signature-256", sig ]
    let result = verifier (Encoding.UTF8.GetBytes(body)) headers
    Assert.Equal(Verify.Valid, result)

[<Fact>]
let ``GitHub verify invalid signature`` () =
    let secret = "test-secret"
    let body = """{"action":"push"}"""
    let wrongSig = computeGitHubSignature "wrong-secret" body
    let verifier = Verify.createGitHubVerifier secret
    let headers = makeHeaders [ "X-Hub-Signature-256", wrongSig ]
    let result = verifier (Encoding.UTF8.GetBytes(body)) headers
    Assert.Equal(Verify.Invalid, result)

[<Fact>]
let ``GitHub verify missing header`` () =
    let verifier = Verify.createGitHubVerifier "test-secret"
    let headers = makeHeaders []
    let result = verifier (Encoding.UTF8.GetBytes("{}")) headers
    match result with
    | Verify.VerifyError _ -> ()
    | other -> failwith $"expected VerifyError, got {other}"

// --- Stripe Verifier Tests ---

[<Fact>]
let ``Stripe verify valid signature`` () =
    let secret = "whsec_test"
    let body = """{"type":"charge.succeeded"}"""
    let ts = "1616161616"
    let sig = computeStripeSignature secret ts body
    let verifier = Verify.createStripeVerifier secret
    let headers = makeHeaders [ "Stripe-Signature", $"t={ts},v1={sig}" ]
    let result = verifier (Encoding.UTF8.GetBytes(body)) headers
    Assert.Equal(Verify.Valid, result)

[<Fact>]
let ``Stripe verify invalid signature`` () =
    let secret = "whsec_test"
    let body = """{"type":"charge.succeeded"}"""
    let ts = "1616161616"
    let wrongSig = computeStripeSignature "wrong-secret" ts body
    let verifier = Verify.createStripeVerifier secret
    let headers = makeHeaders [ "Stripe-Signature", $"t={ts},v1={wrongSig}" ]
    let result = verifier (Encoding.UTF8.GetBytes(body)) headers
    Assert.Equal(Verify.Invalid, result)

[<Fact>]
let ``Stripe verify missing header`` () =
    let verifier = Verify.createStripeVerifier "whsec_test"
    let headers = makeHeaders []
    let result = verifier (Encoding.UTF8.GetBytes("{}")) headers
    match result with
    | Verify.VerifyError _ -> ()
    | other -> failwith $"expected VerifyError, got {other}"

[<Fact>]
let ``Stripe verify malformed headers`` () =
    let verifier = Verify.createStripeVerifier "whsec_test"
    let cases = [
        "not-a-valid-header"   // garbage
        "v1=abc123"            // no timestamp
        "t=1616161616"         // no v1 sig
    ]
    for header in cases do
        let headers = makeHeaders [ "Stripe-Signature", header ]
        let result = verifier (Encoding.UTF8.GetBytes("{}")) headers
        match result with
        | Verify.VerifyError _ -> ()
        | other -> failwith $"expected VerifyError for header '{header}', got {other}"

[<Fact>]
let ``Stripe verify multiple v1 signatures`` () =
    let secret = "whsec_test"
    let body = """{"type":"charge.succeeded"}"""
    let ts = "1616161616"
    let goodSig = computeStripeSignature secret ts body
    let badSig = "deadbeef"
    let verifier = Verify.createStripeVerifier secret
    let headers = makeHeaders [ "Stripe-Signature", $"t={ts},v1={badSig},v1={goodSig}" ]
    let result = verifier (Encoding.UTF8.GetBytes(body)) headers
    Assert.Equal(Verify.Valid, result)

// --- Factory Tests ---

[<Fact>]
let ``Factory creates GitHub verifier`` () =
    match Verify.create "github" "secret" with
    | Ok _ -> ()
    | Error msg -> failwith $"expected Ok, got Error: {msg}"

[<Fact>]
let ``Factory creates Stripe verifier`` () =
    match Verify.create "stripe" "secret" with
    | Ok _ -> ()
    | Error msg -> failwith $"expected Ok, got Error: {msg}"

[<Fact>]
let ``Factory rejects unknown type`` () =
    match Verify.create "unknown" "secret" with
    | Error _ -> ()
    | Ok _ -> failwith "expected Error for unknown verifier type"
