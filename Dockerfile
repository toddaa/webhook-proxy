# Stage 1: Build the Go binary
FROM golang:1-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o webhook-proxy .

# Stage 2: Minimal runtime image
FROM alpine:latest
RUN apk --no-cache add ca-certificates
RUN adduser -D -u 1000 appuser
WORKDIR /app
COPY --from=builder /app/webhook-proxy .
USER appuser
EXPOSE 8080
ENTRYPOINT ["./webhook-proxy"]
