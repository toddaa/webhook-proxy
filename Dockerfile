# Stage 1: Build the F# application
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS builder
WORKDIR /app
COPY src/WebhookProxy.fsproj src/
RUN dotnet restore src/WebhookProxy.fsproj
COPY src/ src/
RUN dotnet publish src/WebhookProxy.fsproj -c Release -o /app/publish --no-restore

# Stage 2: Minimal runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
RUN adduser -D -u 1000 appuser
WORKDIR /app
COPY --from=builder /app/publish .
USER appuser
EXPOSE 8080
ENTRYPOINT ["dotnet", "WebhookProxy.dll"]
