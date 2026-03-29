module WebhookProxy.Tests.ProxyTests

open System
open Xunit
open WebhookProxy

// --- Route Matching Tests ---

[<Fact>]
let ``matchRoute exact match`` () =
    Assert.True(Proxy.matchRoute "/github" "/github")

[<Fact>]
let ``matchRoute prefix match with slash`` () =
    Assert.True(Proxy.matchRoute "/github/push" "/github")

[<Fact>]
let ``matchRoute no match`` () =
    Assert.False(Proxy.matchRoute "/unknown" "/github")

[<Fact>]
let ``matchRoute partial name does not match`` () =
    // /githubx should NOT match /github (only /github/ prefix)
    Assert.False(Proxy.matchRoute "/githubx" "/github")
