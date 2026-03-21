package verify

import (
	"fmt"
	"net/http"
)

// SignatureVerifier verifies webhook signatures.
type SignatureVerifier interface {
	Verify(body []byte, headers http.Header) (bool, error)
}

// New creates a SignatureVerifier for the given provider type and secret.
func New(verifierType, secret string) (SignatureVerifier, error) {
	switch verifierType {
	case "github":
		return NewGitHubVerifier(secret), nil
	case "stripe":
		return NewStripeVerifier(secret), nil
	default:
		return nil, fmt.Errorf("unknown verifier type: %s", verifierType)
	}
}
