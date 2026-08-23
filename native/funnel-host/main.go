package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

const protocolVersion = 1

var (
	hostnamePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	loginURLPattern = regexp.MustCompile(`https://login\.tailscale\.com/[A-Za-z0-9?&=_./%-]+`)
)

type configuration struct {
	stateDir string
	hostname string
}

type command struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Target  string `json:"target"`
}

type reporter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (r *reporter) emit(event map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	event["version"] = protocolVersion
	_ = r.encoder.Encode(event)
}

func (r *reporter) failure(code string) {
	r.emit(map[string]any{"type": "error", "code": code})
}

func (r *reporter) setupFailure(code, setupURL string) {
	event := map[string]any{"type": "error", "code": code}
	if setupURL != "" {
		event["url"] = setupURL
	}
	r.emit(event)
}

func (r *reporter) userLogf(format string, arguments ...any) {
	line := fmt.Sprintf(format, arguments...)
	if loginURL := loginURLPattern.FindString(line); loginURL != "" {
		r.emit(map[string]any{"type": "login", "url": loginURL})
	}
}

func parseConfiguration(arguments []string) (configuration, error) {
	set := flag.NewFlagSet("dsh-mobile-funnel", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	stateDir := set.String("state-dir", "", "private tsnet state directory")
	hostname := set.String("hostname", "", "stable Tailscale hostname")
	if err := set.Parse(arguments); err != nil || set.NArg() != 0 {
		return configuration{}, errors.New("invalid arguments")
	}
	if *stateDir == "" || !hostnamePattern.MatchString(*hostname) {
		return configuration{}, errors.New("invalid arguments")
	}
	return configuration{stateDir: *stateDir, hostname: *hostname}, nil
}

func readCommands(input io.Reader) <-chan command {
	commands := make(chan command, 1)
	go func() {
		defer close(commands)
		decoder := json.NewDecoder(io.LimitReader(input, 64*1024))
		for {
			var next command
			if err := decoder.Decode(&next); err != nil {
				return
			}
			commands <- next
		}
	}()
	return commands
}

func loopbackTarget(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" || target.User != nil || target.Path != "" || target.RawQuery != "" || target.Fragment != "" {
		return nil, errors.New("invalid target")
	}
	host, port, err := net.SplitHostPort(target.Host)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || port == "" {
		return nil, errors.New("invalid target")
	}
	return target, nil
}

func waitForTarget(ctx context.Context, commands <-chan command) (*url.URL, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case next, ok := <-commands:
			if !ok {
				return nil, errors.New("control channel closed")
			}
			if next.Version != protocolVersion || next.Type != "serve" {
				return nil, errors.New("invalid command")
			}
			return loopbackTarget(next.Target)
		}
	}
}

func publicOrigin(dnsName string) (string, error) {
	hostname := strings.TrimSuffix(strings.ToLower(dnsName), ".")
	if !strings.HasSuffix(hostname, ".ts.net") {
		return "", errors.New("tailnet DNS name is unavailable")
	}
	return "https://" + hostname, nil
}

func classifyFunnelFailure(err error) (code, setupURL string) {
	message := err.Error()
	switch {
	case strings.Contains(message, "https://tailscale.com/s/no-funnel"):
		return "funnel_permission_required", "https://tailscale.com/s/no-funnel"
	case strings.Contains(message, "https://tailscale.com/s/https"):
		return "funnel_https_required", "https://tailscale.com/s/https"
	default:
		return "funnel_start_failed", ""
	}
}

func officialSetupURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "login.tailscale.com" || parsed.Port() != "" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}

func queryFunnelSetupURL(ctx context.Context, server *tsnet.Server) string {
	client, err := server.LocalClient()
	if err != nil {
		return ""
	}
	info, err := client.QueryFeature(ctx, "funnel")
	if err != nil || info.Complete {
		return ""
	}
	return officialSetupURL(info.URL)
}

func serveFunnel(ctx context.Context, server *tsnet.Server, target *url.URL, origin string, output *reporter) error {
	listener, err := server.ListenFunnel("tcp", ":443", tsnet.FunnelOnly())
	if err != nil {
		return err
	}
	defer listener.Close()

	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		publicHost := request.Host
		director(request)
		request.Host = publicHost
	}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(response, "gateway unavailable", http.StatusBadGateway)
	}

	httpServer := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	output.emit(map[string]any{"type": "serving", "origin": origin})
	err = httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) || ctx.Err() != nil {
		return nil
	}
	return err
}

func run(arguments []string, input io.Reader, output io.Writer) int {
	reporter := &reporter{encoder: json.NewEncoder(output)}
	config, err := parseConfiguration(arguments)
	if err != nil {
		reporter.failure("invalid_arguments")
		return 2
	}
	if err := os.MkdirAll(config.stateDir, 0o700); err != nil {
		reporter.failure("state_directory_failed")
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &tsnet.Server{
		Dir:      config.stateDir,
		Hostname: config.hostname,
		UserLogf: reporter.userLogf,
		Logf:     func(string, ...any) {},
	}
	defer server.Close()
	status, err := server.Up(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		reporter.failure("tailscale_start_failed")
		return 1
	}
	if status.Self == nil {
		reporter.failure("tailscale_identity_missing")
		return 1
	}
	origin, err := publicOrigin(status.Self.DNSName)
	if err != nil {
		reporter.failure("tailscale_dns_missing")
		return 1
	}
	reporter.emit(map[string]any{"type": "ready", "origin": origin})
	target, err := waitForTarget(ctx, readCommands(input))
	if err != nil {
		if ctx.Err() != nil {
			return 0
		}
		reporter.failure("control_channel_failed")
		return 1
	}
	if err := serveFunnel(ctx, server, target, origin, reporter); err != nil {
		code, setupURL := classifyFunnelFailure(err)
		if code == "funnel_permission_required" || code == "funnel_https_required" {
			if interactiveURL := queryFunnelSetupURL(ctx, server); interactiveURL != "" {
				setupURL = interactiveURL
			}
		}
		reporter.setupFailure(code, setupURL)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}
