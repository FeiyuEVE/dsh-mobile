package main

import (
	"errors"
	"testing"
)

func TestClassifyFunnelFailure(t *testing.T) {
	tests := []struct {
		name      string
		message   string
		wantCode  string
		wantSetup string
	}{
		{
			name:      "funnel permission",
			message:   `Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.`,
			wantCode:  "funnel_permission_required",
			wantSetup: "https://tailscale.com/s/no-funnel",
		},
		{
			name:      "https permission",
			message:   "Funnel not available; HTTPS must be enabled. See https://tailscale.com/s/https.",
			wantCode:  "funnel_https_required",
			wantSetup: "https://tailscale.com/s/https",
		},
		{
			name:     "unknown failure",
			message:  "listener failed",
			wantCode: "funnel_start_failed",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, setupURL := classifyFunnelFailure(errors.New(test.message))
			if code != test.wantCode || setupURL != test.wantSetup {
				t.Fatalf("classifyFunnelFailure() = (%q, %q), want (%q, %q)", code, setupURL, test.wantCode, test.wantSetup)
			}
		})
	}
}

func TestOfficialSetupURL(t *testing.T) {
	valid := "https://login.tailscale.com/admin/feature/funnel?node=node-1"
	if got := officialSetupURL(valid); got != valid {
		t.Fatalf("officialSetupURL() = %q, want %q", got, valid)
	}
	for _, invalid := range []string{
		"http://login.tailscale.com/admin/feature/funnel",
		"https://example.com/admin/feature/funnel",
		"https://login.tailscale.com.evil.example/admin/feature/funnel",
		"https://user@login.tailscale.com/admin/feature/funnel",
	} {
		if got := officialSetupURL(invalid); got != "" {
			t.Fatalf("officialSetupURL(%q) = %q, want empty", invalid, got)
		}
	}
}
