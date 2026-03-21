package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// StripeVerifier verifies Stripe webhook signatures using HMAC-SHA256.
// TODO: Add timestamp tolerance check (e.g., 300s) to prevent replay attacks
// when verification becomes a gatekeeper (rejecting invalid requests).
type StripeVerifier struct {
	secret []byte
}

// NewStripeVerifier creates a new StripeVerifier with the given webhook secret.
func NewStripeVerifier(secret string) *StripeVerifier {
	return &StripeVerifier{secret: []byte(secret)}
}

// Verify checks the Stripe-Signature header against the request body.
// The header format is: t=<timestamp>,v1=<sig>[,v1=<sig>...]
// Returns an error if the header is missing, has no timestamp, or has no v1 signatures.
// Returns false (not error) if no signature matches.
func (v *StripeVerifier) Verify(body []byte, headers http.Header) (bool, error) {
	sig := headers.Get("Stripe-Signature")
	if sig == "" {
		return false, fmt.Errorf("missing Stripe-Signature header")
	}

	var timestamp string
	var v1Sigs []string

	parts := strings.Split(sig, ",")
	for _, part := range parts {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			timestamp = kv[1]
		case "v1":
			v1Sigs = append(v1Sigs, kv[1])
		}
	}

	if timestamp == "" {
		return false, fmt.Errorf("malformed Stripe-Signature header: missing timestamp")
	}
	if len(v1Sigs) == 0 {
		return false, fmt.Errorf("malformed Stripe-Signature header: no v1 signatures")
	}

	// Compute expected signature: HMAC-SHA256 of "<timestamp>.<body>"
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := mac.Sum(nil)

	for _, s := range v1Sigs {
		received, err := hex.DecodeString(s)
		if err != nil {
			continue // skip malformed individual signatures
		}
		if hmac.Equal(expected, received) {
			return true, nil
		}
	}

	return false, nil
}
