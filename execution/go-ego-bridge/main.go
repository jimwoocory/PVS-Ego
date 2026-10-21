// Local acceptance transport only. PVS remains the business authorization authority.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed worker.mjs
var worker string

type config struct {
	Contract   string `json:"contract"`
	Session    string `json:"session"`
	Node       string `json:"node"`
	NodeSHA    string `json:"nodeSha256"`
	CLI        string `json:"cli"`
	CLISHA     string `json:"cliSha256"`
	SDK        string `json:"sdk"`
	SDKSHA     string `json:"sdkSha256"`
	DataDir    string `json:"dataDir"`
	InstanceID string `json:"instanceId"`
	Origin     string `json:"origin"`
	Nonce      string `json:"nonce"`
}
type scope struct {
	ProjectID   string `json:"projectId"`
	CycleID     string `json:"cycleId"`
	ActionID    string `json:"actionId"`
	ContextHash string `json:"contextHash"`
}
type document struct {
	SourceURL string `json:"sourceUrl"`
	FinalURL  string `json:"finalUrl"`
	Title     string `json:"title"`
	Text      string `json:"text"`
	FetchedAt string `json:"fetchedAt"`
	Truncated bool   `json:"truncated"`
}
type request struct {
	Op                string          `json:"op"`
	ID                string          `json:"id"`
	Mode              string          `json:"mode,omitempty"`
	TimeoutMS         int             `json:"timeoutMs,omitempty"`
	Scope             *scope          `json:"scope,omitempty"`
	ResearchRunID     string          `json:"researchRunId,omitempty"`
	Binding           *sessionBinding `json:"binding,omitempty"`
	CaptureScreenshot bool            `json:"captureScreenshot,omitempty"`
}
type sessionBinding struct {
	InstanceID string `json:"instanceId"`
	SpaceID    int    `json:"spaceId"`
	SpaceName  string `json:"spaceName"`
	ProfileID  string `json:"profileId"`
	TargetID   string `json:"targetId"`
	SessionID  string `json:"sessionId"`
}
type researchSession struct {
	binding sessionBinding
	scope   scope
	runID   string
}
type job struct {
	cancel   context.CancelFunc
	reason   string
	terminal bool
	scope    scope
}
type bridge struct {
	mu       sync.Mutex
	cfg      config
	jobs     map[string]*job
	wg       sync.WaitGroup
	seq      int
	out      io.Writer
	sessions map[string]researchSession
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9-]{1,80}$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func decode(data []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("TRAILING_JSON")
	}
	return nil
}
func confined(parent, child string) bool {
	if !filepath.IsAbs(child) {
		return false
	}
	p, e := filepath.EvalSymlinks(parent)
	if e != nil {
		return false
	}
	c, e := filepath.EvalSymlinks(child)
	if e != nil {
		return false
	}
	rel, e := filepath.Rel(p, c)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func pin(file, expected string) error {
	if !filepath.IsAbs(file) || !shaPattern.MatchString(expected) {
		return errors.New("PIN_REQUIRED")
	}
	data, e := os.ReadFile(file)
	if e != nil {
		return errors.New("PIN_UNREADABLE")
	}
	s := sha256.Sum256(data)
	if hex.EncodeToString(s[:]) != expected {
		return errors.New("PIN_CHANGED")
	}
	return nil
}
func (c config) validate(file string) error {
	cwd, _ := os.Getwd()
	sessions := filepath.Join(cwd, ".runtime")
	if c.Contract != "pvs-go-ego-local-v1" || !strings.HasPrefix(filepath.Base(c.Session), "go-bridge-") || !confined(sessions, c.Session) || !confined(c.Session, file) || !confined(c.Session, c.DataDir) {
		return errors.New("LOCAL_SESSION_REQUIRED")
	}
	if c.DataDir != filepath.Join(c.Session, "host") {
		return errors.New("FRESH_HOST_REQUIRED")
	}
	var host struct {
		InstanceID string `json:"instanceId"`
		PID        int    `json:"pid"`
	}
	data, e := os.ReadFile(filepath.Join(c.DataDir, "host-instance.json"))
	if e != nil || json.Unmarshal(data, &host) != nil || c.InstanceID != "windows-host:"+host.InstanceID {
		return errors.New("HOST_BINDING_REQUIRED")
	}
	u, e := url.Parse(c.Origin)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("LOCAL_ORIGIN_REQUIRED")
	}
	switch u.Port() {
	case "3090", "3092", "9223", "19422", "19423":
		return errors.New("PROTECTED_PORT")
	}
	if !identifier.MatchString(c.Nonce) {
		return errors.New("FIXTURE_NONCE_REQUIRED")
	}
	for _, p := range [][2]string{{c.Node, c.NodeSHA}, {c.CLI, c.CLISHA}, {c.SDK, c.SDKSHA}} {
		if e := pin(p[0], p[1]); e != nil {
			return e
		}
	}
	return nil
}

// Call with mu held, so every task has one ordered stream and exactly one terminal event.
func (b *bridge) emit(kind, id, code string, data any) {
	b.seq++
	v := map[string]any{"type": kind, "id": id, "sequence": b.seq, "at": time.Now().UTC().Format(time.RFC3339Nano)}
	if code != "" {
		v["code"] = code
	}
	if data != nil {
		v["data"] = data
	}
	if j := b.jobs[id]; j != nil {
		v["scope"] = j.scope
	}
	_ = json.NewEncoder(b.out).Encode(v)
}
func (b *bridge) reject(id, code string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !identifier.MatchString(id) {
		id = ""
	}
	b.emit("rejected", id, code, nil)
}
func (b *bridge) start(r request) {
	sessionMode := r.Mode == "session-open" || r.Mode == "session-read"
	if !identifier.MatchString(r.ID) || r.Scope == nil || !identifier.MatchString(r.Scope.ProjectID) || !identifier.MatchString(r.Scope.CycleID) || !identifier.MatchString(r.Scope.ActionID) || !shaPattern.MatchString(r.Scope.ContextHash) || (r.Mode != "probe" && r.Mode != "observe" && r.Mode != "capture" && !sessionMode) || r.TimeoutMS < 100 || r.TimeoutMS > 10000 ||
		(sessionMode && !identifier.MatchString(r.ResearchRunID)) || (!sessionMode && (r.ResearchRunID != "" || r.Binding != nil || r.CaptureScreenshot)) || (r.Mode == "session-open" && (r.Binding != nil || r.CaptureScreenshot)) || (r.Mode == "session-read" && r.Binding == nil) {
		b.reject(r.ID, "REQUEST_DENIED")
		return
	}
	if e := pin(b.cfg.CLI, b.cfg.CLISHA); e != nil {
		b.reject(r.ID, "PIN_CHANGED")
		return
	}
	if e := pin(b.cfg.SDK, b.cfg.SDKSHA); e != nil {
		b.reject(r.ID, "PIN_CHANGED")
		return
	}
	if e := pin(b.cfg.Node, b.cfg.NodeSHA); e != nil {
		b.reject(r.ID, "PIN_CHANGED")
		return
	}
	b.mu.Lock()
	if b.sessions == nil {
		b.sessions = make(map[string]researchSession)
	}
	if r.Mode == "session-open" {
		for _, s := range b.sessions {
			if s.scope.ProjectID == r.Scope.ProjectID && s.runID == r.ResearchRunID {
				b.emit("rejected", r.ID, "SESSION_ALREADY_BOUND", nil)
				b.mu.Unlock()
				return
			}
		}
	}
	if r.Mode == "session-read" {
		s, ok := b.sessions[r.Binding.SessionID]
		if !ok || s.binding != *r.Binding || s.scope != *r.Scope || s.runID != r.ResearchRunID {
			b.emit("rejected", r.ID, "SESSION_BINDING_DENIED", nil)
			b.mu.Unlock()
			return
		}
	}
	if _, ok := b.jobs[r.ID]; ok {
		b.emit("rejected", r.ID, "DUPLICATE_ID", nil)
		b.mu.Unlock()
		return
	}
	if len(b.jobs) >= 256 {
		b.emit("rejected", r.ID, "SESSION_LIMIT", nil)
		b.mu.Unlock()
		return
	}
	for _, j := range b.jobs {
		if !j.terminal {
			b.emit("rejected", r.ID, "BUSY", nil)
			b.mu.Unlock()
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(r.TimeoutMS)*time.Millisecond)
	j := &job{cancel: cancel, scope: *r.Scope}
	b.jobs[r.ID] = j
	b.wg.Add(1)
	b.emit("started", r.ID, "", nil)
	b.mu.Unlock()
	go func() { defer b.wg.Done(); defer cancel(); b.run(ctx, r, j) }()
}
func (b *bridge) run(ctx context.Context, r request, j *job) {
	c := b.cfg
	token := make([]byte, 16)
	if _, err := rand.Read(token); err != nil {
		j.cancel()
	}
	sessionID := hex.EncodeToString(token)
	screenshotPath := filepath.Join(c.Session, "evidence", "session-"+r.ID+".png")
	input, _ := json.Marshal(map[string]any{"id": r.ID, "mode": r.Mode, "instanceId": c.InstanceID, "origin": c.Origin, "nonce": c.Nonce, "layoutPath": filepath.Join(c.DataDir, "workspaces.json"),
		"spaceName": "pvs-research-" + r.Scope.ProjectID + "-" + r.ResearchRunID, "binding": r.Binding, "sessionId": sessionID, "captureScreenshot": r.CaptureScreenshot, "screenshotPath": screenshotPath})
	cmd := exec.CommandContext(ctx, c.Node, c.CLI, "nodejs", "--sdk-path", c.SDK)
	cmd.Dir = c.Session
	for _, k := range []string{"SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"} {
		if v := os.Getenv(k); v != "" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	cmd.Env = append(cmd.Env, "EGO_WINDOWS_DATA_DIR="+c.DataDir, "PATH="+filepath.Dir(c.Node), "HOME="+c.Session, "USERPROFILE="+c.Session, "TEMP="+c.Session, "TMP="+c.Session)
	cmd.Stdin = strings.NewReader("globalThis.PVS_GO_BRIDGE_CONFIG=" + string(input) + ";\n" + worker)
	stdout, e := cmd.StdoutPipe()
	cmd.Stderr = io.Discard
	connected, done, protocol, captured, pageBound := false, false, false, false, false
	var opened *sessionBinding
	blockedCode := ""
	screenshotReceived := false
	if e == nil {
		e = cmd.Start()
	}
	if e == nil {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 2_000_000)
		count := 0
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "PVS_GO_EVENT ") {
				continue
			}
			count++
			if count > 64 {
				protocol = true
				j.cancel()
				break
			}
			var event struct {
				Kind             string          `json:"kind"`
				InstanceID       string          `json:"instanceId,omitempty"`
				SpaceID          int             `json:"spaceId,omitempty"`
				TargetID         string          `json:"targetId,omitempty"`
				Tick             int             `json:"tick,omitempty"`
				Document         *document       `json:"document,omitempty"`
				Binding          *sessionBinding `json:"binding,omitempty"`
				Code             string          `json:"code,omitempty"`
				Visibility       string          `json:"visibility,omitempty"`
				VisibilitySource string          `json:"visibilitySource,omitempty"`
				PNG              string          `json:"png,omitempty"`
			}
			if decode([]byte(strings.TrimPrefix(line, "PVS_GO_EVENT ")), &event) != nil {
				protocol = true
				j.cancel()
				break
			}
			switch event.Kind {
			case "connected":
				if event.InstanceID != c.InstanceID || connected {
					protocol = true
				}
				connected = true
			case "page":
				if !connected || pageBound || event.SpaceID < 1 || event.TargetID == "" || r.Mode == "probe" {
					protocol = true
				}
				pageBound = true
				if r.Mode == "session-read" && (event.SpaceID != r.Binding.SpaceID || event.TargetID != r.Binding.TargetID) {
					protocol = true
				}
			case "session":
				s := event.Binding
				if r.Mode != "session-open" || !pageBound || opened != nil || s == nil || s.InstanceID != c.InstanceID || s.SpaceID < 1 || s.TargetID == "" || s.SpaceName != "pvs-research-"+r.Scope.ProjectID+"-"+r.ResearchRunID || s.ProfileID != "Default" || s.SessionID != sessionID {
					protocol = true
				} else {
					opened = s
				}
			case "visibility":
				if r.Mode != "session-read" || !pageBound || event.VisibilitySource != "OWNED_HOST_LAYOUT_SNAPSHOT" || (event.Visibility != "visible" && event.Visibility != "hidden") {
					protocol = true
				}
			case "blocked":
				if r.Mode != "session-open" && r.Mode != "session-read" {
					protocol = true
				}
				switch event.Code {
				case "HOST_INSTANCE_CHANGED", "CONTROL_CHANGED", "FIXTURE_BINDING_CHANGED", "SPACE_HIDDEN", "SCREENSHOT_FAILED", "SESSION_READ_FAILED":
					blockedCode = event.Code
				default:
					protocol = true
				}
			case "screenshot":
				if r.Mode != "session-read" || !r.CaptureScreenshot || !captured || screenshotReceived || done || len(event.PNG) > 1_400_000 {
					protocol = true
				} else {
					png, err := base64.StdEncoding.DecodeString(event.PNG)
					if err != nil || len(png) > 1_000_000 || len(png) < 8 || !bytes.Equal(png[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
						protocol = true
					} else {
						screenshotReceived = true
					}
				}
			case "sample":
				if !connected || event.Tick < 0 {
					protocol = true
				}
			case "done":
				if done || (blockedCode == "" && (!connected || (r.Mode == "capture" && !captured) || (r.Mode == "session-open" && opened == nil) || (r.Mode == "session-read" && (!captured || (r.CaptureScreenshot && !screenshotReceived))))) {
					protocol = true
				}
				done = true
			case "document":
				d := event.Document
				if (r.Mode != "capture" && r.Mode != "session-read") || !pageBound || captured || done || d == nil || blockedCode != "" {
					protocol = true
				} else {
					_, timeErr := time.Parse(time.RFC3339Nano, d.FetchedAt)
					if d.SourceURL != c.Origin+"/bridge-fixture/"+c.Nonce || d.FinalURL != d.SourceURL || len(d.Title) < 1 || len(d.Title) > 1024 || len(d.Text) < 1 || len(d.Text) > 16000 || timeErr != nil {
						protocol = true
					}
				}
				captured = true
			default:
				protocol = true
			}
			if protocol {
				j.cancel()
				break
			}
			b.mu.Lock()
			if j.reason == "" && ctx.Err() == nil && !j.terminal {
				b.emit(event.Kind, r.ID, "", event)
			}
			b.mu.Unlock()
		}
		if scanner.Err() != nil {
			protocol = true
			j.cancel()
		}
		e = cmd.Wait()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	kind, code := "succeeded", ""
	switch {
	case j.reason != "":
		kind = j.reason
	case ctx.Err() == context.DeadlineExceeded:
		kind = "timed_out"
	case protocol:
		kind = "failed"
		code = "WORKER_PROTOCOL"
	case blockedCode != "":
		kind = "failed"
		code = blockedCode
	case e != nil || !done:
		kind = "failed"
		code = "WORKER_FAILED"
	}
	j.terminal = true
	if kind == "succeeded" && r.Mode == "session-open" && opened != nil {
		b.sessions[opened.SessionID] = researchSession{binding: *opened, scope: *r.Scope, runID: r.ResearchRunID}
	}
	result := map[string]any{"workerStarted": cmd.Process != nil, "workerExited": cmd.ProcessState != nil, "remoteActionsRolledBack": false}
	if cmd.Process != nil {
		result["workerPid"] = cmd.Process.Pid
	}
	b.emit(kind, r.ID, code, result)
}
func (b *bridge) cancel(id, reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	j := b.jobs[id]
	if j == nil {
		b.emit("rejected", id, "UNKNOWN_ID", nil)
		return
	}
	if j.terminal {
		b.emit("rejected", id, "JOB_TERMINAL", nil)
		return
	}
	if j.reason == "" {
		j.reason = reason
		j.cancel()
	}
}
func (b *bridge) close() {
	b.mu.Lock()
	for _, j := range b.jobs {
		if !j.terminal && j.reason == "" {
			j.reason = "cancelled"
			j.cancel()
		}
	}
	b.mu.Unlock()
	b.wg.Wait()
}
func main() {
	file := flag.String("config", "", "explicit local config")
	flag.Parse()
	if flag.NArg() != 0 || *file == "" {
		fmt.Fprintln(os.Stderr, "CONFIG_REQUIRED")
		os.Exit(2)
	}
	data, e := os.ReadFile(*file)
	var c config
	if e == nil {
		e = decode(data, &c)
	}
	if e == nil {
		e = c.validate(*file)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e.Error())
		os.Exit(2)
	}
	b := &bridge{cfg: c, jobs: make(map[string]*job), out: os.Stdout}
	b.emit("ready", "", "", map[string]any{"contract": c.Contract, "instanceId": c.InstanceID, "productionEnabled": false})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 16384)
	for scanner.Scan() {
		var r request
		if decode(scanner.Bytes(), &r) != nil {
			b.reject("", "INVALID_REQUEST")
			continue
		}
		switch r.Op {
		case "start":
			b.start(r)
		case "cancel":
			if r.Mode != "" || r.TimeoutMS != 0 || r.Scope != nil || r.Binding != nil || r.ResearchRunID != "" || r.CaptureScreenshot || !identifier.MatchString(r.ID) {
				b.reject("", "REQUEST_DENIED")
			} else {
				b.cancel(r.ID, "cancelled")
			}
		default:
			b.reject(r.ID, "OPERATION_DENIED")
		}
	}
	b.close()
	if scanner.Err() != nil {
		fmt.Fprintln(os.Stderr, "INPUT_LIMIT")
		os.Exit(2)
	}
}
