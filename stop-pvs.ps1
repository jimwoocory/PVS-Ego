$ErrorActionPreference = "Stop"
Write-Output "隔离服务只以前台进程运行；在其终端按 Ctrl+C。此入口不操作计划任务、共享 helper 或3090进程。"
exit 0
