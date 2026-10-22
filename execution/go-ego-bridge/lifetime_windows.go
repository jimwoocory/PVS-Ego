//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

type jobBasicLimits struct {
	ProcessTime, JobTime int64
	Flags                uint32
	Minimum, Maximum     uintptr
	ActiveProcesses      uint32
	Affinity             uintptr
	Priority, Scheduling uint32
}
type jobIOLimits struct {
	ReadOperations, WriteOperations, OtherOperations uint64
	ReadBytes, WriteBytes, OtherBytes                uint64
}
type jobExtendedLimits struct {
	Basic                                                      jobBasicLimits
	IO                                                         jobIOLimits
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

// This unnamed job contains only this bridge and its future descendants. Put
// the bridge in the job BEFORE launching any worker, so forced bridge death has
// no spawn/assign race. The last handle is owned only by this process.
var ownedLifetimeJob syscall.Handle

func installWorkerLifetimeGuard() error {
	kernel := syscall.NewLazyDLL("kernel32.dll")
	create := kernel.NewProc("CreateJobObjectW")
	set := kernel.NewProc("SetInformationJobObject")
	assign := kernel.NewProc("AssignProcessToJobObject")
	current := kernel.NewProc("GetCurrentProcess")
	job, _, _ := create.Call(0, 0)
	if job == 0 {
		return errors.New("OWNED_JOB_CREATE_FAILED")
	}
	info := jobExtendedLimits{}
	// Windows 64-bit JOBOBJECT_EXTENDED_LIMIT_INFORMATION. Other layouts fail
	// closed rather than submitting a mismatched native structure.
	if unsafe.Sizeof(info) != 144 {
		syscall.CloseHandle(syscall.Handle(job))
		return errors.New("OWNED_JOB_LAYOUT_UNSUPPORTED")
	}
	info.Basic.Flags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	ok, _, _ := set.Call(job, 9, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		return errors.New("OWNED_JOB_LIMIT_FAILED")
	}
	process, _, _ := current.Call()
	ok, _, _ = assign.Call(job, process)
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		return errors.New("OWNED_JOB_ASSIGN_FAILED")
	}
	// Do not explicitly close this handle while the bridge is alive: that would
	// terminate the bridge itself. OS process teardown closes it after normal EOF
	// or forced termination and also ends remaining owned workers.
	ownedLifetimeJob = syscall.Handle(job)
	return nil
}
