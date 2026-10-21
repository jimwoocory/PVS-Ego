package main

// Native process fixtures only: no Ego SDK, browser, model or network.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 3 && os.Args[1] == "pipe-holder" {
		marker := os.Args[2]
		_ = os.WriteFile(marker+".pid", []byte(fmt.Sprint(os.Getpid())), 0600)
		for start := time.Now(); time.Since(start) < 10*time.Second; {
			if _, err := os.Stat(marker + ".release"); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(75)
	}
	if len(os.Args) == 5 && os.Args[2] == "nodejs" && os.Args[3] == "--sdk-path" {
		fixtureWorker()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fixtureWorker() {
	input, _ := io.ReadAll(os.Stdin)
	line := strings.SplitN(string(input), "\n", 2)[0]
	var cfg struct {
		InstanceID, Origin, Nonce, SpaceName, SessionID string
		Binding                                         *sessionBinding
	}
	if json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(line, "globalThis.PVS_GO_BRIDGE_CONFIG="), ";")), &cfg) != nil {
		os.Exit(70)
	}
	data, _ := os.ReadFile(os.Args[4])
	scenario := string(data)
	emit := func(value any) { b, _ := json.Marshal(value); fmt.Println("PVS_GO_EVENT " + string(b)) }
	if strings.Contains(scenario, "inherited") {
		child := exec.Command(os.Args[0], "pipe-holder", os.Args[4])
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(71)
		}
		for start := time.Now(); ; {
			if _, err := os.Stat(os.Args[4] + ".pid"); err == nil {
				break
			}
			if time.Since(start) > 2*time.Second {
				os.Exit(72)
			}
			time.Sleep(time.Millisecond)
		}
	}
	emit(map[string]any{"kind": "connected", "instanceId": cfg.InstanceID})
	if strings.Contains(scenario, "hold") {
		time.Sleep(10 * time.Second)
		return
	}
	if scenario == "junk" {
		for i := 0; i < 129; i++ {
			fmt.Println("unframed fixture line")
		}
		return
	}
	if scenario == "wrong-mode-sample" {
		emit(map[string]any{"kind": "sample", "tick": 1})
	}
	if cfg.Binding != nil || strings.Contains(scenario, "open") || scenario == "observe" {
		emit(map[string]any{"kind": "page", "spaceId": 1, "targetId": "fixture-page"})
	}
	if strings.Contains(scenario, "open") {
		space, target := 1, "fixture-page"
		if scenario == "open-wrong-space" {
			space = 2
		}
		if scenario == "open-wrong-target" {
			target = "another-page"
		}
		emit(map[string]any{"kind": "session", "binding": sessionBinding{InstanceID: cfg.InstanceID, SpaceID: space, SpaceName: cfg.SpaceName, ProfileID: "Default", TargetID: target, SessionID: cfg.SessionID}})
	}
	if cfg.Binding != nil {
		visibility := "visible"
		if scenario == "hidden-shot" || scenario == "read-hidden" {
			visibility = "hidden"
		}
		v := map[string]any{"kind": "visibility", "visibility": visibility, "visibilitySource": "OWNED_HOST_LAYOUT_SNAPSHOT"}
		if scenario != "read-no-visibility" && scenario != "read-late-visibility" {
			emit(v)
		}
		if scenario == "read-duplicate-visibility" {
			emit(v)
		}
		emit(map[string]any{"kind": "document", "document": document{SourceURL: cfg.Origin + "/bridge-fixture/" + cfg.Nonce, FinalURL: cfg.Origin + "/bridge-fixture/" + cfg.Nonce, Title: "fixture", Text: "synthetic", FetchedAt: time.Now().UTC().Format(time.RFC3339Nano)}})
		if scenario == "read-late-visibility" {
			emit(v)
		}
		if scenario == "hidden-shot" || scenario == "read-shot" {
			emit(map[string]any{"kind": "screenshot", "png": "iVBORw0KGgo="})
		}
	}
	if scenario == "blocked" || scenario == "blocked-extra" {
		emit(map[string]any{"kind": "blocked", "code": "CONTROL_CHANGED"})
	}
	if scenario == "blocked-extra" {
		emit(map[string]any{"kind": "page", "spaceId": 1, "targetId": "fixture-page"})
	}
	emit(map[string]any{"kind": "done"})
	if scenario == "after-done" {
		emit(map[string]any{"kind": "sample", "tick": 1})
	}
	if scenario == "duplicate-done" {
		emit(map[string]any{"kind": "done"})
	}
}

type eventLog struct {
	sync.Mutex
	bytes.Buffer
}

func (l *eventLog) Write(p []byte) (int, error) { l.Lock(); defer l.Unlock(); return l.Buffer.Write(p) }
func (l *eventLog) events() []map[string]any {
	l.Lock()
	defer l.Unlock()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.Buffer.String()), "\n") {
		var e map[string]any
		if json.Unmarshal([]byte(line), &e) == nil {
			events = append(events, e)
		}
	}
	return events
}
func waitFor(t *testing.T, fn func() bool) {
	t.Helper()
	start := time.Now()
	for !fn() {
		if time.Since(start) > 3*time.Second {
			t.Fatal("bounded fixture wait expired")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func testBridge(t *testing.T, scenario string) (*bridge, *eventLog, request) {
	t.Helper()
	base := os.Getenv("PVS_GO_LIFECYCLE_SESSION")
	if base == "" || !filepath.IsAbs(base) {
		t.Fatal("isolated runner required")
	}
	dir, err := os.MkdirTemp(base, "native-")
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cli, sdk := filepath.Join(dir, "fixture-cli"), filepath.Join(dir, "fixture-sdk")
	for file, body := range map[string]string{cli: "inert", sdk: scenario} {
		if err := os.WriteFile(file, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	hash := func(file string) string {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		s := sha256.Sum256(data)
		return hex.EncodeToString(s[:])
	}
	log := new(eventLog)
	b := &bridge{cfg: config{Node: exe, NodeSHA: hash(exe), CLI: cli, CLISHA: hash(cli), SDK: sdk, SDKSHA: hash(sdk), Session: dir, DataDir: dir, InstanceID: "windows-host:fixture", Origin: "http://127.0.0.1:12345", Nonce: "fixture"}, jobs: make(map[string]*job), out: log}
	r := request{Op: "start", ID: "fixture-job", Mode: "probe", TimeoutMS: 2000, Scope: &scope{ProjectID: "project", CycleID: "cycle", ActionID: "action", ContextHash: strings.Repeat("a", 64)}}
	if strings.Contains(scenario, "open") || strings.HasPrefix(scenario, "blocked") {
		r.Mode = "session-open"
		r.ResearchRunID = "run"
	}
	if strings.HasPrefix(scenario, "read-") || scenario == "hidden-shot" {
		r.Mode = "session-read"
		r.ResearchRunID = "run"
		r.Binding = &sessionBinding{InstanceID: b.cfg.InstanceID, SpaceID: 1, SpaceName: "pvs-research-project-run", ProfileID: "Default", TargetID: "fixture-page", SessionID: "session"}
		b.sessions = map[string]researchSession{"session": {binding: *r.Binding, scope: *r.Scope, runID: "run"}}
		r.CaptureScreenshot = scenario == "hidden-shot" || scenario == "read-shot"
	}
	if scenario == "observe" {
		r.Mode = "observe"
	}
	t.Cleanup(func() { b.close() })
	return b, log, r
}
func terminal(t *testing.T, b *bridge, log *eventLog, want, code string) {
	t.Helper()
	waitFor(t, func() bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		return b.jobs["fixture-job"] != nil && b.jobs["fixture-job"].terminal
	})
	events := log.events()
	last := events[len(events)-1]
	if last["type"] != want || (code != "" && last["code"] != code) {
		t.Fatalf("terminal: %#v", last)
	}
	data := last["data"].(map[string]any)
	if data["workerStarted"] != true || data["workerExited"] != true || data["remoteActionsRolledBack"] != false {
		t.Fatalf("exit receipt: %#v", data)
	}
	count := 0
	for _, e := range events {
		if e["type"] == "succeeded" || e["type"] == "failed" || e["type"] == "cancelled" || e["type"] == "timed_out" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("terminal count", count)
	}
	t.Logf("direct worker pid=%d reaped=true terminal=%s", int(data["workerPid"].(float64)), want)
}

func TestBridgeProtocol(t *testing.T) {
	for _, scenario := range []string{"probe", "observe", "open", "read-valid", "read-hidden", "read-shot", "open-wrong-space", "open-wrong-target", "read-no-visibility", "read-late-visibility", "read-duplicate-visibility", "hidden-shot", "wrong-mode-sample", "after-done", "duplicate-done", "blocked", "blocked-extra", "junk"} {
		t.Run(scenario, func(t *testing.T) {
			b, log, r := testBridge(t, scenario)
			b.start(r)
			want, code := "failed", "WORKER_PROTOCOL"
			switch scenario {
			case "probe", "observe", "open", "read-valid", "read-hidden", "read-shot":
				want, code = "succeeded", ""
			case "blocked":
				code = "CONTROL_CHANGED"
			}
			terminal(t, b, log, want, code)
			if strings.HasPrefix(scenario, "open-wrong") && len(b.sessions) != 0 {
				t.Fatal("invalid binding retained")
			}
		})
	}
}

func TestBridgeInheritedPipes(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows process-handle and inherited-pipe regression")
	}
	for _, action := range []string{"cancel", "deadline", "eof", "input-limit", "exited-parent"} {
		t.Run(action, func(t *testing.T) {
			scenario := "inherited-hold"
			if action == "exited-parent" {
				scenario = "inherited-exit"
			}
			b, log, r := testBridge(t, scenario)
			r.TimeoutMS = 500
			if action == "cancel" || action == "eof" || action == "input-limit" {
				r.TimeoutMS = 5000
			}
			marker := b.cfg.SDK
			var holder *os.Process
			t.Cleanup(func() {
				_ = os.WriteFile(marker+".release", nil, 0600)
				if holder != nil {
					state, err := holder.Wait()
					if err != nil || !state.Success() {
						t.Errorf("pipe holder exit: %v %v", state, err)
					} else {
						t.Logf("pipe holder pid=%d exited=0", holder.Pid)
					}
				}
			})
			reader, writer := io.Pipe()
			served := make(chan error, 1)
			go func() { defer reader.Close(); served <- b.serve(reader) }()
			payload, _ := json.Marshal(r)
			_, _ = fmt.Fprintln(writer, string(payload))
			waitFor(t, func() bool { _, e := os.Stat(marker + ".pid"); return e == nil })
			pidText, _ := os.ReadFile(marker + ".pid")
			var pid int
			_, _ = fmt.Sscan(string(pidText), &pid)
			var err error
			holder, err = os.FindProcess(pid)
			if err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			want := "timed_out"
			switch action {
			case "cancel":
				_, _ = fmt.Fprintln(writer, `{"op":"cancel","id":"fixture-job"}`)
				want = "cancelled"
			case "eof":
				_ = writer.Close()
				want = "cancelled"
			case "input-limit":
				go func() { _, _ = fmt.Fprintln(writer, strings.Repeat("x", 17000)); _ = writer.Close() }()
				want = "cancelled"
			}
			terminal(t, b, log, want, "")
			if time.Since(start) > 1500*time.Millisecond {
				t.Fatal("terminal waited for inherited stdout/stderr")
			}
			_ = writer.Close()
			select {
			case err := <-served:
				if (action == "input-limit") != (err != nil) {
					t.Fatalf("input result %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("input close did not drain")
			}
			t.Logf("terminal=%s direct worker reaped; descendant required separate fixture cleanup", want)
		})
	}
}
