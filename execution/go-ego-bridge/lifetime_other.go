//go:build !windows

package main

import "errors"

func installWorkerLifetimeGuard() error {
	return errors.New("WINDOWS_WORKER_LIFETIME_GUARD_REQUIRED")
}
