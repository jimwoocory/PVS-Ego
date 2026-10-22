package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

//go:embed ops-worker.mjs
var opsWorker string

type opsConfig struct {
	Base        config          `json:"base"`
	Operation   string          `json:"operation"`
	Source      string          `json:"source"`
	SpaceName   string          `json:"spaceName"`
	Binding     *sessionBinding `json:"binding,omitempty"`
	Scope       scope           `json:"scope"`
	ExpectedUID string          `json:"expectedAccountUid,omitempty"`
	Count       int             `json:"count,omitempty"`
	Cursor      string          `json:"cursor,omitempty"`
	LastWorkID  string          `json:"lastWorkId,omitempty"`
}
type opsOutput struct{ bytes []byte }

func (w *opsOutput) Write(p []byte) (int, error) {
	if len(w.bytes)+len(p) > 500000 {
		return 0, io.ErrShortWrite
	}
	w.bytes = append(w.bytes, p...)
	return len(p), nil
}

// A one-shot, separately validated operation. It never accepts JavaScript, URLs,
// platform write commands or arbitrary SDK methods from the business process.
func opsMain(file string) int {
	var c opsConfig
	data, e := os.ReadFile(file)
	if e == nil {
		e = decode(data, &c)
	}
	if e == nil {
		e = c.Base.validate(file)
	}
	if e == nil && (c.Operation != "open" && c.Operation != "identity" && c.Operation != "works") {
		e = fmt.Errorf("OPS_OPERATION_DENIED")
	}
	if e == nil && (c.Source != "LIVE_DOUYIN" && c.Source != "LOCAL_FIXTURE_ONLY") {
		e = fmt.Errorf("OPS_SOURCE_DENIED")
	}
	if e == nil && (!strings.HasPrefix(c.SpaceName, "pvs-ops-") || !identifier.MatchString(c.SpaceName) || !identifier.MatchString(c.Scope.ProjectID) || !identifier.MatchString(c.Scope.CycleID) || !identifier.MatchString(c.Scope.ActionID) || !shaPattern.MatchString(c.Scope.ContextHash)) {
		e = fmt.Errorf("OPS_SCOPE_DENIED")
	}
	if e == nil && ((c.Operation == "works" && (!regexp.MustCompile(`^(0|[1-9]\d{0,19})$`).MatchString(c.Cursor) || (c.Cursor == "0" && c.LastWorkID != "") || (c.Cursor != "0" && !regexp.MustCompile(`^\d{8,30}$`).MatchString(c.LastWorkID)) || c.Count < 1 || c.Count > 20 || len(c.ExpectedUID) < 1 || len(c.ExpectedUID) > 40)) || (c.Operation != "works" && (c.Count != 0 || c.ExpectedUID != "" || c.Cursor != "" || c.LastWorkID != ""))) {
		e = fmt.Errorf("OPS_ARGUMENT_DENIED")
	}
	if e == nil && ((c.Operation == "open" && c.Binding != nil) || (c.Operation != "open" && (c.Binding == nil || c.Binding.InstanceID != c.Base.InstanceID || c.Binding.SpaceName != c.SpaceName || c.Binding.ProfileID != "Default" || c.Binding.SpaceID < 1 || c.Binding.TargetID == ""))) {
		e = fmt.Errorf("OPS_BINDING_DENIED")
	}
	if e == nil {
		e = installWorkerLifetimeGuard()
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "OPS_CONFIGURATION_DENIED")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() { var b [1]byte; _, _ = os.Stdin.Read(b[:]); cancel() }()
	encoded, _ := json.Marshal(c)
	cmd := exec.CommandContext(ctx, c.Base.Node, c.Base.CLI, "nodejs", "--sdk-path", c.Base.SDK)
	cmd.Dir = c.Base.Session
	cmd.WaitDelay = 250 * time.Millisecond
	for _, key := range []string{"SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"} {
		if v := os.Getenv(key); v != "" {
			cmd.Env = append(cmd.Env, key+"="+v)
		}
	}
	cmd.Env = append(cmd.Env, "EGO_WINDOWS_DATA_DIR="+c.Base.DataDir, "PATH="+filepath.Dir(c.Base.Node), "HOME="+c.Base.Session, "USERPROFILE="+c.Base.Session, "TEMP="+c.Base.Session, "TMP="+c.Base.Session)
	cmd.Stdin = strings.NewReader("globalThis.PVS_EGO_OPS=" + string(encoded) + ";\n" + opsWorker)
	output := &opsOutput{}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	e = cmd.Run()
	terminal := "FAILED"
	var result json.RawMessage
	if ctx.Err() == context.DeadlineExceeded {
		terminal = "TIMED_OUT"
	} else if ctx.Err() != nil {
		terminal = "CANCELLED"
	} else if e == nil {
		found := 0
		for _, line := range strings.Split(string(output.bytes), "\n") {
			if strings.HasPrefix(line, "PVS_EGO_OPS ") {
				found++
				result = json.RawMessage(strings.TrimPrefix(line, "PVS_EGO_OPS "))
			}
		}
		if found == 1 && json.Valid(result) {
			terminal = "SUCCEEDED"
		}
	}
	// OS wait has returned before publishing an exit receipt. Forced termination
	// of this Go owner is also contained by its kill-on-close Job Object.
	reply := map[string]any{"contract": "pvs-ego-douyin-read-v1", "scope": c.Scope, "operation": c.Operation, "terminal": terminal, "workerExited": cmd.ProcessState != nil}
	if cmd.Process != nil {
		reply["workerPid"] = cmd.Process.Pid
	}
	if terminal == "SUCCEEDED" {
		reply["result"] = result
	}
	_ = json.NewEncoder(os.Stdout).Encode(reply)
	return 0
}
