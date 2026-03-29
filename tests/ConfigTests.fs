module WebhookProxy.Tests.ConfigTests

open System
open System.IO
open Xunit
open WebhookProxy

/// Write YAML content to a temp file and return the path.
let writeTempConfig (yaml: string) : string =
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString())
    Directory.CreateDirectory(dir) |> ignore
    let path = Path.Combine(dir, "config.yaml")
    File.WriteAllText(path, yaml)
    path

[<Fact>]
let ``Load valid config`` () =
    let yaml = """
server:
  port: 9090
  request_timeout: 15s
routes:
  - path: /github
    target: http://localhost:5678/webhook/github
    description: "GitHub webhooks"
  - path: /health
    target: ""
    description: "Health check"
    health_check: true
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Error msg -> failwith $"unexpected error: {msg}"
    | Ok cfg ->
        Assert.Equal(9090, cfg.Port)
        Assert.Equal(TimeSpan.FromSeconds(15.0), cfg.RequestTimeout)
        Assert.Equal(2, cfg.Routes.Length)
        Assert.Equal("/github", cfg.Routes.[0].Path)

[<Fact>]
let ``Load applies defaults`` () =
    let yaml = """
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Error msg -> failwith $"unexpected error: {msg}"
    | Ok cfg ->
        Assert.Equal(8080, cfg.Port)
        Assert.Equal(TimeSpan.FromSeconds(30.0), cfg.RequestTimeout)

[<Fact>]
let ``Validation rejects duplicate paths`` () =
    let yaml = """
routes:
  - path: /test
    target: http://localhost:8080
    description: "test1"
  - path: /test
    target: http://localhost:8081
    description: "test2"
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for duplicate paths"
    | Error _ -> ()

[<Fact>]
let ``Validation rejects missing target`` () =
    let yaml = """
routes:
  - path: /test
    target: ""
    description: "missing target"
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for missing target on non-health-check route"
    | Error _ -> ()

[<Fact>]
let ``Validation rejects unknown verifier type`` () =
    let yaml = """
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
    verify_signature:
      type: unknown_provider
      secret_env: SECRET
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for unknown verifier type"
    | Error _ -> ()

[<Fact>]
let ``Health check allows empty target`` () =
    let yaml = """
routes:
  - path: /health
    target: ""
    description: "health"
    health_check: true
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Error msg -> failwith $"health check should allow empty target, got: {msg}"
    | Ok _ -> ()

[<Fact>]
let ``Validation rejects empty routes`` () =
    let yaml = """
server:
  port: 8080
routes: []
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for empty routes"
    | Error _ -> ()

[<Fact>]
let ``Validation rejects path without leading slash`` () =
    let yaml = """
routes:
  - path: github
    target: http://localhost:8080
    description: "missing slash"
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for path without leading slash"
    | Error _ -> ()

[<Fact>]
let ``Validation rejects missing secret_env`` () =
    let yaml = """
routes:
  - path: /test
    target: http://localhost:8080
    description: "test"
    verify_signature:
      type: github
      secret_env: ""
"""
    let path = writeTempConfig yaml
    match Config.load path with
    | Ok _ -> failwith "expected error for missing secret_env"
    | Error _ -> ()
