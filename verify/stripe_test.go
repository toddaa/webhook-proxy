package verify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"testing"
)

func computeStripeSignature(secret, timestamp, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "." + body))
	return hex.EncodeToString(mac.Sum(nil))
}

func TestStripeVerifyValidSignature(t *testing.T) {
	secret := "whsec_test"
	body := `{"type":"charge.succeeded"}`
	ts := "1616161616"
	sig := computeStripeSignature(secret, ts, body)

	v := NewStripeVerifier(secret)
	headers := http.Header{}
	headers.Set("Stripe-Signature", fmt.Sprintf("t=%s,v1=%s", ts, sig))

	ok, err := v.Verify([]byte(body), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected valid signature to pass verification")
	}
}

func TestStripeVerifyInvalidSignature(t *testing.T) {
	secret := "whsec_test"
	body := `{"type":"charge.succeeded"}`
	ts := "1616161616"
	wrongSig := computeStripeSignature("wrong-secret", ts, body)

	v := NewStripeVerifier(secret)
	headers := http.Header{}
	headers.Set("Stripe-Signature", fmt.Sprintf("t=%s,v1=%s", ts, wrongSig))

	ok, err := v.Verify([]byte(body), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected invalid signature to fail verification")
	}
}

func TestStripeVerifyMissingHeader(t *testing.T) {
	v := NewStripeVerifier("whsec_test")
	headers := http.Header{}

	_, err := v.Verify([]byte(`{}`), headers)
	if err == nil {
		t.Fatal("expected error for missing header")
	}
}

func TestStripeVerifyMalformedHeader(t *testing.T) {
	v := NewStripeVerifier("whsec_test")

	tests := []struct {
		name   string
		header string
	}{
		{"garbage", "not-a-valid-header"},
		{"no timestamp", "v1=abc123"},
		{"no v1 sig", "t=1616161616"},
		{"empty", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			headers := http.Header{}
			headers.Set("Stripe-Signature", tc.header)

			_, err := v.Verify([]byte(`{}`), headers)
			if err == nil {
				t.Fatalf("expected error for malformed header %q", tc.header)
			}
		})
	}
}

func TestStripeVerifyMultipleV1Signatures(t *testing.T) {
	secret := "whsec_test"
	body := `{"type":"charge.succeeded"}`
	ts := "1616161616"
	goodSig := computeStripeSignature(secret, ts, body)
	badSig := "deadbeef"

	v := NewStripeVerifier(secret)
	headers := http.Header{}
	headers.Set("Stripe-Signature", fmt.Sprintf("t=%s,v1=%s,v1=%s", ts, badSig, goodSig))

	ok, err := v.Verify([]byte(body), headers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Fatal("expected verification to pass when one of multiple v1 sigs matches")
	}
}
