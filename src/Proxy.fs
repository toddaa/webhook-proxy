namespace WebhookProxy

open System
open System.Diagnostics
open System.IO
open System.Net.Http
open System.Text.Json
open Microsoft.AspNetCore.Http

/// HTTP handler that routes incoming webhook requests to configured backends.
/// Supports health check routes with concurrent target probing, optional signature
/// verification (informational only), and reverse proxying.
module Proxy =

    /// Maximum request body size for signature verification (10 MB).
    let [<Literal>] private MaxBodySize = 10 * 1024 * 1024

    /// A parsed route entry with its optional verifier.
    type RouteEntry = {
        Route: Config.Route
        Verifier: Verify.Verifier option
    }

    /// State for the proxy handler, created at startup.
    type HandlerState = {
        Entries: RouteEntry list
        Config: Config.ValidatedConfig
        Logger: Logger.T
        StartTime: DateTime
        HttpClient: HttpClient
    }

    /// Check whether a request path matches a route path (exact or prefix with /).
    let matchRoute (reqPath: string) (routePath: string) : bool =
        reqPath = routePath || reqPath.StartsWith(routePath + "/")

    /// Write a JSON error response.
    let private writeJsonError (ctx: HttpContext) (message: string) (statusCode: int) = task {
        ctx.Response.ContentType <- "application/json"
        ctx.Response.StatusCode <- statusCode
        let payload = {| error = message; code = statusCode |}
        do! JsonSerializer.SerializeAsync(ctx.Response.Body, payload)
    }

    /// Write a JSON response with the given object.
    let private writeJson (ctx: HttpContext) (statusCode: int) (value: obj) = task {
        ctx.Response.ContentType <- "application/json"
        ctx.Response.StatusCode <- statusCode
        let options = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower)
        options.Encoder <- System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        do! JsonSerializer.SerializeAsync(ctx.Response.Body, value, options)
    }

    /// Probe a target URL and return its status for health checks.
    let private probeTarget (client: HttpClient) (targetUrl: string) = task {
        let sw = Stopwatch.StartNew()
        try
            let! resp = client.GetAsync(targetUrl)
            sw.Stop()
            let elapsed = sw.ElapsedMilliseconds
            if int resp.StatusCode >= 200 && int resp.StatusCode < 300 then
                return {| status = "up"; response_time_ms = Nullable<int64>(elapsed); error = (null: string) |}
            else
                return {| status = "down"; response_time_ms = Nullable<int64>(); error = $"HTTP {int resp.StatusCode}" |}
        with ex ->
            sw.Stop()
            return {| status = "down"; response_time_ms = Nullable<int64>(); error = ex.Message |}
    }

    /// Handle a health check request: return JSON with concurrent target probing.
    let private handleHealthCheck (state: HandlerState) (ctx: HttpContext) = task {
        let probeClient = new HttpClient(Timeout = TimeSpan.FromSeconds(5.0))

        // Collect non-health-check entries for probing
        let probeEntries =
            state.Entries
            |> List.filter (fun e -> not e.Route.HealthCheck)

        // Probe all targets concurrently
        let! results =
            probeEntries
            |> List.map (fun e -> task {
                let! result = probeTarget probeClient e.Route.Target
                return e.Route.Path, result
            })
            |> System.Threading.Tasks.Task.WhenAll

        let uptime = (DateTime.UtcNow - state.StartTime).ToString()

        // Build the targets dictionary
        let targets =
            results
            |> Array.map (fun (path, result) -> path, result :> obj)
            |> dict

        let response = {| status = "ok"; routes = probeEntries.Length; uptime = uptime; targets = targets |}
        do! writeJson ctx StatusCodes.Status200OK response
    }

    /// Forward a request to the target backend (reverse proxy).
    let private proxyRequest (state: HandlerState) (entry: RouteEntry) (ctx: HttpContext) = task {
        let targetUri = Uri(entry.Route.Target)

        // Compute the extra path beyond the route prefix
        let extra = ctx.Request.Path.Value.Substring(entry.Route.Path.Length)
        let targetPath = targetUri.AbsolutePath + extra

        // Build the forwarded request
        let targetUrl =
            UriBuilder(
                Scheme = targetUri.Scheme,
                Host = targetUri.Host,
                Port = targetUri.Port,
                Path = targetPath,
                Query = if ctx.Request.QueryString.HasValue then ctx.Request.QueryString.Value.TrimStart('?') else ""
            ).Uri

        use reqMsg = new HttpRequestMessage(HttpMethod(ctx.Request.Method), targetUrl)

        // Copy request headers (skip Host, it will be set by HttpClient)
        for header in ctx.Request.Headers do
            if not (header.Key.Equals("Host", StringComparison.OrdinalIgnoreCase)) then
                reqMsg.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()) |> ignore

        // Add proxy headers
        reqMsg.Headers.TryAddWithoutValidation("X-Webhook-Proxy-Route", entry.Route.Path) |> ignore
        reqMsg.Headers.TryAddWithoutValidation("X-Webhook-Proxy-Timestamp", DateTime.UtcNow.ToString("o")) |> ignore

        // Copy the request body if present
        if ctx.Request.ContentLength.HasValue && ctx.Request.ContentLength.Value > 0L
           || ctx.Request.Headers.ContainsKey("Transfer-Encoding") then
            let ms = new MemoryStream()
            do! ctx.Request.Body.CopyToAsync(ms)
            ms.Position <- 0L
            reqMsg.Content <- new StreamContent(ms)
            // Copy content headers
            if ctx.Request.ContentType <> null then
                reqMsg.Content.Headers.ContentType <-
                    System.Net.Http.Headers.MediaTypeHeaderValue.Parse(ctx.Request.ContentType)
            if ctx.Request.ContentLength.HasValue then
                reqMsg.Content.Headers.ContentLength <- ctx.Request.ContentLength

        try
            let! resp = state.HttpClient.SendAsync(reqMsg, HttpCompletionOption.ResponseHeadersRead)

            // Write the response status code
            ctx.Response.StatusCode <- int resp.StatusCode

            // Copy response headers
            for header in resp.Headers do
                ctx.Response.Headers.TryAdd(header.Key, Microsoft.Extensions.Primitives.StringValues(header.Value |> Seq.toArray)) |> ignore
            for header in resp.Content.Headers do
                ctx.Response.Headers.TryAdd(header.Key, Microsoft.Extensions.Primitives.StringValues(header.Value |> Seq.toArray)) |> ignore

            // Remove transfer-encoding since Kestrel handles this
            ctx.Response.Headers.Remove("transfer-encoding") |> ignore

            // Copy response body
            do! resp.Content.CopyToAsync(ctx.Response.Body)

            return int resp.StatusCode
        with ex ->
            do! writeJsonError ctx $"upstream error: {ex.Message}" StatusCodes.Status502BadGateway
            return StatusCodes.Status502BadGateway
    }

    /// Create the handler state from a validated config and logger.
    let createState (config: Config.ValidatedConfig) (logger: Logger.T) : HandlerState =
        let client = new HttpClient(Timeout = config.RequestTimeout)

        let entries =
            config.Routes
            |> List.choose (fun route ->
                if route.HealthCheck then
                    Some { Route = route; Verifier = None }
                else
                    // Create optional verifier
                    let verifier =
                        if Config.hasVerifySignature route then
                            let secret = Environment.GetEnvironmentVariable(route.VerifySignature.SecretEnv)
                            if not (String.IsNullOrEmpty secret) then
                                match Verify.create route.VerifySignature.Type secret with
                                | Ok v -> Some v
                                | Error msg ->
                                    logger |> Logger.logFields [
                                        "event", "verifier_create_error" :> obj
                                        "path", route.Path :> obj
                                        "error", msg :> obj
                                    ]
                                    None
                            else
                                None
                        else
                            None

                    Some { Route = route; Verifier = verifier }
            )

        {
            Entries = entries
            Config = config
            Logger = logger
            StartTime = DateTime.UtcNow
            HttpClient = client
        }

    /// Log a request with structured fields.
    let private logRequest
        (logger: Logger.T)
        (method: string)
        (path: string)
        (route: string option)
        (status: int)
        (durationMs: int64)
        (sigResult: bool option) =
        let fields = [
            "event", "request" :> obj
            "method", method :> obj
            "path", path :> obj
            "duration_ms", durationMs :> obj
        ]
        let fields =
            match route with
            | Some r -> fields @ [ "route", r :> obj ]
            | None -> fields
        let fields =
            if status <> 0 then fields @ [ "status", status :> obj ]
            else fields
        let fields =
            match sigResult with
            | Some v -> fields @ [ "signature_valid", v :> obj ]
            | None -> fields
        logger |> Logger.logFields fields

    /// The main request handler. Matches routes and dispatches to health check,
    /// signature verification, or proxying as appropriate.
    let handleRequest (state: HandlerState) (ctx: HttpContext) = task {
        let sw = Stopwatch.StartNew()
        let reqPath = ctx.Request.Path.Value

        // Find the first matching route entry
        let matchedEntry =
            state.Entries
            |> List.tryFind (fun e -> matchRoute reqPath e.Route.Path)

        match matchedEntry with
        | None ->
            // No matching route
            do! writeJsonError ctx "no matching route" StatusCodes.Status404NotFound
            sw.Stop()
            logRequest state.Logger ctx.Request.Method reqPath None StatusCodes.Status404NotFound sw.ElapsedMilliseconds None

        | Some entry when entry.Route.HealthCheck ->
            // Health check route
            do! handleHealthCheck state ctx
            sw.Stop()
            logRequest state.Logger ctx.Request.Method reqPath (Some entry.Route.Path) StatusCodes.Status200OK sw.ElapsedMilliseconds None

        | Some entry ->
            // Signature verification (informational only, always proxy)
            let mutable sigResult: bool option = None

            match entry.Verifier with
            | Some verifier ->
                // Buffer the body for signature verification, then restore for proxying
                let ms = new MemoryStream()
                do! ctx.Request.Body.CopyToAsync(ms)
                let bodyBytes =
                    if ms.Length > int64 MaxBodySize then
                        ms.ToArray() |> Array.take MaxBodySize
                    else
                        ms.ToArray()

                // Reset the body stream so the proxy can read it
                ms.Position <- 0L
                ctx.Request.Body <- ms

                let result = verifier bodyBytes ctx.Request.Headers
                match result with
                | Verify.Valid ->
                    sigResult <- Some true
                    state.Logger |> Logger.logFields [
                        "event", "signature_verification" :> obj
                        "path", reqPath :> obj
                        "route", entry.Route.Path :> obj
                        "signature_valid", true :> obj
                    ]
                | Verify.Invalid ->
                    sigResult <- Some false
                    state.Logger |> Logger.logFields [
                        "event", "signature_verification" :> obj
                        "path", reqPath :> obj
                        "route", entry.Route.Path :> obj
                        "signature_valid", false :> obj
                    ]
                | Verify.VerifyError msg ->
                    sigResult <- Some false
                    state.Logger |> Logger.logFields [
                        "event", "signature_verification_error" :> obj
                        "path", reqPath :> obj
                        "route", entry.Route.Path :> obj
                        "error", msg :> obj
                    ]
            | None -> ()

            // Proxy the request to the target
            let! status = proxyRequest state entry ctx
            sw.Stop()
            logRequest state.Logger ctx.Request.Method reqPath (Some entry.Route.Path) status sw.ElapsedMilliseconds sigResult
    }
