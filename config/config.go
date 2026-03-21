package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the top-level configuration structure parsed from config.yaml.
type Config struct {
	Server ServerConfig `yaml:"server"`
	Routes []Route      `yaml:"routes"`
}

// ServerConfig holds server-level settings.
type ServerConfig struct {
	Port           int           `yaml:"port"`
	RequestTimeout time.Duration `yaml:"request_timeout"`
}

// Route defines a single webhook route: an incoming path mapped to a target URL.
type Route struct {
	Path            string           `yaml:"path"`
	Target          string           `yaml:"target"`
	Description     string           `yaml:"description"`
	HealthCheck     bool             `yaml:"health_check"`
	VerifySignature *SignatureConfig `yaml:"verify_signature"`
}

// SignatureConfig holds the configuration for webhook signature verification.
type SignatureConfig struct {
	Type      string `yaml:"type"`
	SecretEnv string `yaml:"secret_env"`
}

// knownVerifierTypes lists the signature verification types we support.
var knownVerifierTypes = map[string]bool{
	"github": true,
	"stripe": true,
}

// Load reads and parses a YAML config file, applies defaults, and validates.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config file: %w", err)
	}

	cfg := &Config{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config file: %w", err)
	}

	applyDefaults(cfg)

	if err := validate(cfg); err != nil {
		return nil, fmt.Errorf("config validation: %w", err)
	}

	return cfg, nil
}

// applyDefaults sets default values for any fields not specified in the config.
func applyDefaults(cfg *Config) {
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8080
	}
	if cfg.Server.RequestTimeout == 0 {
		cfg.Server.RequestTimeout = 30 * time.Second
	}
}

// validate checks the config for logical errors.
func validate(cfg *Config) error {
	if len(cfg.Routes) == 0 {
		return fmt.Errorf("at least one route is required")
	}

	seen := make(map[string]bool)
	for _, r := range cfg.Routes {
		if !strings.HasPrefix(r.Path, "/") {
			return fmt.Errorf("route path must start with /: %s", r.Path)
		}

		if seen[r.Path] {
			return fmt.Errorf("duplicate route path: %s", r.Path)
		}
		seen[r.Path] = true

		if !r.HealthCheck && r.Target == "" {
			return fmt.Errorf("route %s: target is required for non-health-check routes", r.Path)
		}

		if r.VerifySignature != nil {
			if !knownVerifierTypes[r.VerifySignature.Type] {
				return fmt.Errorf("route %s: unknown signature verification type: %s", r.Path, r.VerifySignature.Type)
			}
			if r.VerifySignature.SecretEnv == "" {
				return fmt.Errorf("route %s: secret_env is required when verify_signature is configured", r.Path)
			}
		}
	}
	return nil
}
