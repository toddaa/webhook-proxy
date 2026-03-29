namespace WebhookProxy

open System
open System.Security.Cryptography
open System.Text
open Microsoft.AspNetCore.Http

/// Signature verification for webhook providers.
/// Each verifier takes a request body and headers and returns whether the signature is valid.
module Verify =

    /// The result of a signature verification attempt.
    type VerifyResult =
        | Valid
        | Invalid
        | VerifyError of string

    /// Verifier is a function: body bytes -> IHeaderDictionary -> VerifyResult
    type Verifier = byte[] -> IHeaderDictionary -> VerifyResult

    /// Compute HMAC-SHA256 of the given data with the given key, returning raw bytes.
    let private hmacSha256 (key: byte[]) (data: byte[]) : byte[] =
        use hmac = new HMACSHA256(key)
        hmac.ComputeHash(data)

    /// Constant-time comparison of two byte arrays.
    let private constantTimeEquals (a: byte[]) (b: byte[]) : bool =
        if a.Length <> b.Length then false
        else CryptographicOperations.FixedTimeEquals(ReadOnlySpan(a), ReadOnlySpan(b))

    /// GitHub webhook signature verifier using HMAC-SHA256.
    /// Reads the X-Hub-Signature-256 header (format: sha256=<hex>).
    let createGitHubVerifier (secret: string) : Verifier =
        let secretBytes = Encoding.UTF8.GetBytes(secret)
        fun (body: byte[]) (headers: IHeaderDictionary) ->
            let sigHeader =
                match headers.TryGetValue("X-Hub-Signature-256") with
                | true, values -> values.ToString()
                | _ -> ""

            if String.IsNullOrEmpty(sigHeader) then
                VerifyError "missing X-Hub-Signature-256 header"
            elif not (sigHeader.StartsWith("sha256=")) then
                VerifyError "malformed X-Hub-Signature-256 header: missing sha256= prefix"
            else
                let receivedHex = sigHeader.Substring(7) // skip "sha256="
                try
                    let received = Convert.FromHexString(receivedHex)
                    let expected = hmacSha256 secretBytes body

                    if constantTimeEquals expected received then Valid
                    else Invalid
                with ex ->
                    VerifyError $"malformed X-Hub-Signature-256 header: invalid hex: {ex.Message}"

    /// Stripe webhook signature verifier using HMAC-SHA256.
    /// Reads the Stripe-Signature header (format: t=<timestamp>,v1=<sig>[,v1=<sig>...]).
    /// Signs "<timestamp>.<body>".
    let createStripeVerifier (secret: string) : Verifier =
        let secretBytes = Encoding.UTF8.GetBytes(secret)
        fun (body: byte[]) (headers: IHeaderDictionary) ->
            let sigHeader =
                match headers.TryGetValue("Stripe-Signature") with
                | true, values -> values.ToString()
                | _ -> ""

            if String.IsNullOrEmpty(sigHeader) then
                VerifyError "missing Stripe-Signature header"
            else
                // Parse the header into key=value pairs
                let parts = sigHeader.Split(',')
                let mutable timestamp = ""
                let mutable v1Sigs = []

                for part in parts do
                    match part.Split('=', 2) with
                    | [| "t"; value |] -> timestamp <- value
                    | [| "v1"; value |] -> v1Sigs <- value :: v1Sigs
                    | _ -> ()

                if String.IsNullOrEmpty(timestamp) then
                    VerifyError "malformed Stripe-Signature header: missing timestamp"
                elif v1Sigs.IsEmpty then
                    VerifyError "malformed Stripe-Signature header: no v1 signatures"
                else
                    // Compute expected signature: HMAC-SHA256 of "<timestamp>.<body>"
                    let payload =
                        Array.concat [
                            Encoding.UTF8.GetBytes(timestamp)
                            Encoding.UTF8.GetBytes(".")
                            body
                        ]
                    let expected = hmacSha256 secretBytes payload

                    // Check if any v1 signature matches
                    let anyMatch =
                        v1Sigs
                        |> List.exists (fun sigHex ->
                            try
                                let received = Convert.FromHexString(sigHex)
                                constantTimeEquals expected received
                            with _ ->
                                false // skip malformed individual signatures
                        )

                    if anyMatch then Valid else Invalid

    /// Factory function: create a verifier for the given provider type and secret.
    let create (verifierType: string) (secret: string) : Result<Verifier, string> =
        match verifierType with
        | "github" -> Ok (createGitHubVerifier secret)
        | "stripe" -> Ok (createStripeVerifier secret)
        | other -> Error $"unknown verifier type: {other}"
