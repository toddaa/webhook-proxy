module WebhookProxy.Tests.LoggerTests

open System.IO
open System.Text.Json
open System.Threading
open Xunit
open WebhookProxy

[<Fact>]
let ``Log output is valid JSON with expected fields`` () =
    let sw = new StringWriter()
    let logger = Logger.create sw
    logger |> Logger.logFields [ "event", "test" :> obj; "message", "hello" :> obj ]

    let output = sw.ToString().Trim()
    let doc = JsonDocument.Parse(output)
    let root = doc.RootElement

    Assert.Equal("test", root.GetProperty("event").GetString())
    Assert.Equal("hello", root.GetProperty("message").GetString())
    Assert.True(root.TryGetProperty("timestamp") |> fst, "expected timestamp field")

[<Fact>]
let ``Log adds timestamp`` () =
    let sw = new StringWriter()
    let logger = Logger.create sw
    logger |> Logger.logFields [ "event", "test" :> obj ]

    let output = sw.ToString().Trim()
    let doc = JsonDocument.Parse(output)
    let root = doc.RootElement

    let ts = root.GetProperty("timestamp").GetString()
    Assert.False(System.String.IsNullOrEmpty(ts), "timestamp should be a non-empty string")

[<Fact>]
let ``Log with empty fields still adds timestamp`` () =
    let sw = new StringWriter()
    let logger = Logger.create sw
    logger |> Logger.log Map.empty

    let output = sw.ToString().Trim()
    let doc = JsonDocument.Parse(output)
    let root = doc.RootElement
    Assert.True(root.TryGetProperty("timestamp") |> fst, "expected timestamp field")

[<Fact>]
let ``Log is thread-safe`` () =
    let sw = new StringWriter()
    let logger = Logger.create sw

    let threads =
        [| for i in 0..99 ->
            Thread(fun () ->
                logger |> Logger.logFields [ "n", i :> obj ]
            )
        |]

    threads |> Array.iter (fun t -> t.Start())
    threads |> Array.iter (fun t -> t.Join())

    // Each log call produces one line; we should have 100 lines
    let lines = sw.ToString().Trim().Split('\n') |> Array.filter (fun s -> s.Trim() <> "")
    Assert.Equal(100, lines.Length)
