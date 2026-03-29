namespace WebhookProxy

open System
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting
open Microsoft.Extensions.Hosting

/// Entry point: loads config, creates the HTTP server with Kestrel,
/// and handles graceful shutdown on SIGINT/SIGTERM.
module Program =

    [<EntryPoint>]
    let main args =
        let logger = Logger.createStdout ()

        // Determine config file path (default: config.yaml, override with CONFIG_PATH env)
        let configPath =
            match Environment.GetEnvironmentVariable("CONFIG_PATH") with
            | null | "" -> "config.yaml"
            | path -> path

        // Load and validate configuration
        match Config.load configPath with
        | Error msg ->
            logger |> Logger.logFields [
                "event", "startup_error" :> obj
                "error", $"failed to load config: {msg}" :> obj
            ]
            1 // exit code

        | Ok config ->
            logger |> Logger.logFields [
                "event", "startup" :> obj
                "port", config.Port :> obj
                "routes", config.Routes.Length :> obj
            ]

            // Create the proxy handler state
            let state = Proxy.createState config logger

            // Build and configure the web host
            let builder = WebApplication.CreateBuilder(args)

            builder.WebHost.ConfigureKestrel(fun opts ->
                opts.ListenAnyIP(config.Port)
            ) |> ignore

            // Set the shutdown timeout to 15 seconds
            builder.Host.ConfigureHostOptions(fun opts ->
                opts.ShutdownTimeout <- TimeSpan.FromSeconds(15.0)
            ) |> ignore

            let app = builder.Build()

            // Use a catch-all route that delegates to our proxy handler
            app.Run(fun ctx -> Proxy.handleRequest state ctx)

            // Register shutdown logging
            let lifetime = app.Services.GetService(typeof<IHostApplicationLifetime>) :?> IHostApplicationLifetime
            lifetime.ApplicationStopping.Register(fun () ->
                logger |> Logger.logFields [ "event", "shutdown_start" :> obj ]
            ) |> ignore
            lifetime.ApplicationStopped.Register(fun () ->
                logger |> Logger.logFields [ "event", "shutdown_complete" :> obj ]
            ) |> ignore

            app.Run()
            0
