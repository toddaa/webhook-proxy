package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bergwerk/webhook-proxy/config"
	"github.com/bergwerk/webhook-proxy/logger"
	"github.com/bergwerk/webhook-proxy/proxy"
)

func main() {
	log := logger.NewStdout()

	// Determine config file path (default: config.yaml, override with CONFIG_PATH env)
	configPath := "config.yaml"
	if p := os.Getenv("CONFIG_PATH"); p != "" {
		configPath = p
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Log(map[string]any{
			"event": "startup_error",
			"error": fmt.Sprintf("failed to load config: %v", err),
		})
		os.Exit(1)
	}

	log.Log(map[string]any{
		"event":  "startup",
		"port":   cfg.Server.Port,
		"routes": len(cfg.Routes),
	})

	handler := proxy.NewHandler(cfg, log)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Server.Port),
		Handler:      handler,
		ReadTimeout:  cfg.Server.RequestTimeout,
		WriteTimeout: cfg.Server.RequestTimeout,
	}

	// Start server in a goroutine so we can listen for shutdown signals
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Log(map[string]any{
				"event": "server_error",
				"error": err.Error(),
			})
			os.Exit(1)
		}
	}()

	// Wait for SIGINT or SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit

	log.Log(map[string]any{
		"event":  "shutdown_start",
		"signal": sig.String(),
	})

	// Graceful shutdown with 15-second timeout
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Log(map[string]any{
			"event": "shutdown_error",
			"error": err.Error(),
		})
	}

	log.Log(map[string]any{
		"event": "shutdown_complete",
	})
}
