namespace WebhookProxy

open System
open System.IO
open YamlDotNet.Serialization
open YamlDotNet.Serialization.NamingConventions

/// Configuration types and loading logic. Reads YAML config with server settings
/// and route definitions, applies defaults, and validates.
module Config =

    /// Signature verification configuration for a route.
    [<CLIMutable>]
    type SignatureConfig = {
        [<YamlMember(Alias = "type")>]
        Type: string
        [<YamlMember(Alias = "secret_env")>]
        SecretEnv: string
    }

    /// A single webhook route: an incoming path mapped to a target URL.
    [<CLIMutable>]
    type Route = {
        [<YamlMember(Alias = "path")>]
        Path: string
        [<YamlMember(Alias = "target")>]
        Target: string
        [<YamlMember(Alias = "description")>]
        Description: string
        [<YamlMember(Alias = "health_check")>]
        HealthCheck: bool
        [<YamlMember(Alias = "verify_signature")>]
        VerifySignature: SignatureConfig
    }

    /// Server-level settings.
    [<CLIMutable>]
    type ServerConfig = {
        [<YamlMember(Alias = "port")>]
        Port: int
        [<YamlMember(Alias = "request_timeout")>]
        RequestTimeout: string
    }

    /// Top-level configuration structure parsed from config.yaml.
    [<CLIMutable>]
    type AppConfig = {
        [<YamlMember(Alias = "server")>]
        Server: ServerConfig
        [<YamlMember(Alias = "routes")>]
        Routes: Route list
    }

    /// Parsed and validated configuration with typed timeout.
    type ValidatedConfig = {
        Port: int
        RequestTimeout: TimeSpan
        Routes: Route list
    }

    /// Known verifier types we support.
    let private knownVerifierTypes = set [ "github"; "stripe" ]

    /// Parse a Go-style duration string like "30s" or "15s" into a TimeSpan.
    let private parseDuration (s: string) : Result<TimeSpan, string> =
        if String.IsNullOrWhiteSpace(s) then
            Ok (TimeSpan.FromSeconds(30.0))
        elif s.EndsWith("s") then
            match Double.TryParse(s.TrimEnd('s')) with
            | true, seconds -> Ok (TimeSpan.FromSeconds(seconds))
            | _ -> Error $"invalid duration: {s}"
        elif s.EndsWith("m") then
            match Double.TryParse(s.TrimEnd('m')) with
            | true, minutes -> Ok (TimeSpan.FromMinutes(minutes))
            | _ -> Error $"invalid duration: {s}"
        else
            Error $"unsupported duration format: {s}"

    /// Apply default values for any fields not specified in the config.
    let private applyDefaults (cfg: AppConfig) : AppConfig =
        { cfg with
            Server = {
                cfg.Server with
                    Port = if cfg.Server.Port = 0 then 8080 else cfg.Server.Port
                    RequestTimeout =
                        if String.IsNullOrWhiteSpace(cfg.Server.RequestTimeout) then "30s"
                        else cfg.Server.RequestTimeout
            }
        }

    /// Validate the config for logical errors. Returns Ok with a ValidatedConfig
    /// or Error with a description of the problem.
    let private validate (cfg: AppConfig) : Result<ValidatedConfig, string> =
        // Parse the timeout duration
        match parseDuration cfg.Server.RequestTimeout with
        | Error msg -> Error $"config validation: {msg}"
        | Ok timeout ->

        // At least one route is required
        if cfg.Routes |> List.isEmpty then
            Error "config validation: at least one route is required"
        else

        // Check each route for validity
        let rec checkRoutes (routes: Route list) (seen: Set<string>) =
            match routes with
            | [] -> Ok ()
            | r :: rest ->
                if not (r.Path.StartsWith("/")) then
                    Error $"config validation: route path must start with /: {r.Path}"
                elif seen.Contains(r.Path) then
                    Error $"config validation: duplicate route path: {r.Path}"
                elif not r.HealthCheck && String.IsNullOrEmpty(r.Target) then
                    Error $"config validation: route {r.Path}: target is required for non-health-check routes"
                elif not (isNull (box r.VerifySignature)) && not (String.IsNullOrEmpty r.VerifySignature.Type) then
                    if not (knownVerifierTypes.Contains(r.VerifySignature.Type)) then
                        Error $"config validation: route {r.Path}: unknown signature verification type: {r.VerifySignature.Type}"
                    elif String.IsNullOrEmpty(r.VerifySignature.SecretEnv) then
                        Error $"config validation: route {r.Path}: secret_env is required when verify_signature is configured"
                    else
                        checkRoutes rest (seen.Add(r.Path))
                else
                    checkRoutes rest (seen.Add(r.Path))

        match checkRoutes cfg.Routes Set.empty with
        | Error msg -> Error msg
        | Ok () ->
            Ok {
                Port = cfg.Server.Port
                RequestTimeout = timeout
                Routes = cfg.Routes
            }

    /// Load reads and parses a YAML config file, applies defaults, and validates.
    let load (path: string) : Result<ValidatedConfig, string> =
        try
            let yaml = File.ReadAllText(path)
            let deserializer =
                DeserializerBuilder()
                    .WithNamingConvention(UnderscoredNamingConvention.Instance)
                    .Build()
            let cfg = deserializer.Deserialize<AppConfig>(yaml)
            let cfg = applyDefaults cfg
            validate cfg
        with ex ->
            Error $"reading config file: {ex.Message}"

    /// Check whether a route has signature verification configured.
    let hasVerifySignature (route: Route) : bool =
        not (isNull (box route.VerifySignature))
        && not (String.IsNullOrEmpty route.VerifySignature.Type)
