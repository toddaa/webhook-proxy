namespace WebhookProxy

open System
open System.IO
open System.Text.Json

/// Minimal structured JSON logger that writes one JSON object per line to a TextWriter.
/// Thread-safe via locking.
module Logger =

    /// A logger instance that writes structured JSON to the given writer.
    type T = {
        Writer: TextWriter
        Lock: obj
    }

    /// Create a logger that writes to the given TextWriter.
    let create (writer: TextWriter) : T =
        { Writer = writer; Lock = obj () }

    /// Create a logger that writes to stdout.
    let createStdout () : T =
        create Console.Out

    /// Write a single structured JSON log entry. Automatically adds a "timestamp" field
    /// with the current UTC time in RFC3339 (ISO 8601) format.
    let log (fields: Map<string, obj>) (logger: T) =
        lock logger.Lock (fun () ->
            // Build the entry with a timestamp added
            let entry =
                fields
                |> Map.add "timestamp" (DateTime.UtcNow.ToString("o") :> obj)

            try
                // Serialize the map to JSON using System.Text.Json
                let options = JsonSerializerOptions(PropertyNamingPolicy = null)
                options.Encoder <- System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
                let json = JsonSerializer.Serialize(entry, options)
                logger.Writer.WriteLine(json)
                logger.Writer.Flush()
            with ex ->
                // Fallback: log the serialization error itself
                let fallback =
                    Map.ofList [
                        "timestamp", (DateTime.UtcNow.ToString("o") :> obj)
                        "event", ("log_error" :> obj)
                        "error", (ex.Message :> obj)
                    ]
                let json = JsonSerializer.Serialize(fallback)
                logger.Writer.WriteLine(json)
                logger.Writer.Flush()
        )

    /// Convenience: log with a list of key-value pairs.
    let logFields (fields: (string * obj) list) (logger: T) =
        log (Map.ofList fields) logger
