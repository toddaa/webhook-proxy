package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
)

func computeGitHubSignature(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestGitHubVerifyValidSignature(t *testing.T) {
	secret := "test-secret"
	body := `{"action":"push"}`
	sig := computeGitHubSignature(secret, body)

	v := NewGitHubVerifier(secret)
	headers := http.Header{}
	headers.Set("X-Hub-Signature-256", sig)

	ok, err := v.Verify([]byte(body), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected valid signature to pass verification")
	}
}

func TestGitHubVerifyInvalidSignature(t *testing.T) {
	secret := "test-secret"
	body := `{"action":"push"}`
	wrongSig := computeGitHubSignature("wrong-secret", body)

	v := NewGitHubVerifier(secret)
	headers := http.Header{}
	headers.Set("X-Hub-Signature-256", wrongSig)

	ok, err := v.Verify([]byte(body), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected invalid signature to fail verification")
	}
}

func TestGitHubVerifyMissingHeader(t *testing.T) {
	v := NewGitHubVerifier("test-secret")
	headers := http.Header{}

	_, err := v.Verify([]byte(`{}`), headers)
	if err == nil {
		t.Fatal("expected error for missing header")
	}
}
