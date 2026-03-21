package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// GitHubVerifier verifies GitHub webhook signatures using HMAC-SHA256.
type GitHubVerifier struct {
	secret []byte
}

// NewGitHubVerifier creates a new GitHubVerifier with the given shared secret.
func NewGitHubVerifier(secret string) *GitHubVerifier {
	return &GitHubVerifier{secret: []byte(secret)}
}

// Verify checks the X-Hub-Signature-256 header against the request body.
// Returns an error if the header is missing or malformed.
// Returns false (not error) if the signature does not match.
func (v *GitHubVerifier) Verify(body []byte, headers http.Header) (bool, error) {
	sig := headers.Get("X-Hub-Signature-256")
	if sig == "" {
		return false, fmt.Errorf("missing X-Hub-Signature-256 header")
	}

	if !strings.HasPrefix(sig, "sha256=") {
		return false, fmt.Errorf("malformed X-Hub-Signature-256 header: missing sha256= prefix")
	}

	receivedHex := sig[len("sha256="):]
	received, err := hex.DecodeString(receivedHex)
	if err != nil {
		return false, fmt.Errorf("malformed X-Hub-Signature-256 header: invalid hex: %w", err)
	}

	mac := hmac.New(sha256.New, v.secret)
	mac.Write(body)
	expected := mac.Sum(nil)

	return hmac.Equal(expected, received), nil
}
