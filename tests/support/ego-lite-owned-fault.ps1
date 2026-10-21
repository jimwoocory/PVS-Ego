param(
  [Parameter(Mandatory=$true)][int]$TargetProcessId,
  [Parameter(Mandatory=$true)][int]$ExpectedParentId,
  [Parameter(Mandatory=$true)][string]$ActionDirectory,
  [Parameter(Mandatory=$true)][ValidateSet('ArmSuspend','Suspend','Resume','Terminate','FreezeWorker')][string]$Mode
)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$allowed=[IO.Path]::GetFullPath((Join-Path $repoRoot '.runtime'))+[IO.Path]::DirectorySeparatorChar
$targetDirectory=[IO.Path]::GetFullPath($ActionDirectory)
if(!$targetDirectory.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or !((Split-Path $targetDirectory -Leaf).StartsWith($(if($Mode -eq 'ArmSuspend'){'go-bridge-workbench-'}else{'go-bridge-action-'})))){throw 'OWNED_ACTION_DIRECTORY_REQUIRED'}
$item=Get-Item -LiteralPath $targetDirectory
if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OWNED_ACTION_LINK_DENIED'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedEgoFault {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
if($Mode -eq 'ArmSuspend'){
  [Console]::Out.WriteLine('ARMED');[Console]::Out.Flush()
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while([DateTime]::UtcNow -lt $deadline){
    foreach($directory in @(Get-ChildItem -LiteralPath $targetDirectory -Directory -Filter 'go-bridge-action-*')){
      if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'OWNED_ACTION_LINK_DENIED'}
      $entry=Join-Path $directory.FullName 'host.mjs'
      $hostRecord=Get-CimInstance Win32_Process -Filter "ParentProcessId=$ExpectedParentId" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($entry)} | Select-Object -First 1
      if(!$hostRecord){continue}
      $handle=[OwnedEgoFault]::OpenProcess(0x800,$false,[int]$hostRecord.ProcessId)
      if($handle -eq [IntPtr]::Zero){throw 'OWNED_PROCESS_HANDLE_DENIED'}
      try{
        # Validate once while the host starts, then freeze as soon as the real
        # supervisor has written its fixed Go config. No production test hook.
        $config=Join-Path $directory.FullName 'config.json'
        while(!(Test-Path -LiteralPath $config)){
          if([DateTime]::UtcNow -ge $deadline){throw 'OWNED_HOST_CONFIG_TIMEOUT'}
          Start-Sleep -Milliseconds 5
        }
        $instance=Get-Content -LiteralPath (Join-Path $directory.FullName 'host/host-instance.json') -Raw | ConvertFrom-Json
        if($instance.pid -ne $hostRecord.ProcessId){throw 'OWNED_HOST_INSTANCE_CHANGED'}
        $result=[OwnedEgoFault]::NtSuspendProcess($handle)
        if($result -ne 0){throw 'OWNED_PROCESS_SUSPEND_FAILED'}
        @{pid=[int]$hostRecord.ProcessId;mode='Suspend';result=$result;actionDirectory=$directory.FullName} | ConvertTo-Json -Compress
        exit 0
      }finally{[void][OwnedEgoFault]::CloseHandle($handle)}
    }
    Start-Sleep -Milliseconds 10
  }
  throw 'OWNED_HOST_ARM_TIMEOUT'
}
$record=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId"
if(!$record -or $record.ParentProcessId -ne $ExpectedParentId){throw 'OWNED_PROCESS_PARENT_CHANGED'}
$marker=Join-Path $targetDirectory $(if($Mode -eq 'FreezeWorker'){'config.json'}else{'host.mjs'})
if(!$record.CommandLine.Contains($marker)){throw 'OWNED_PROCESS_COMMAND_CHANGED'}
if($Mode -eq 'FreezeWorker'){
  $config=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetProcessId")
  @{expectedCli=$config.cli;expectedSdk=$config.sdk;children=@($children | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $targetDirectory 'fault-worker-inspection.json') -Encoding UTF8
  $workers=@($children | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($config.cli) -and $_.CommandLine.Contains($config.sdk) -and $_.CommandLine.Contains('nodejs')})
  if(!$workers.Count){throw 'OWNED_GO_WORKER_NOT_RUNNING'}
  $ancillary=@($children | Where-Object {$_.ProcessId -notin @($workers | ForEach-Object ProcessId)})
  foreach($other in $ancillary){
    if($other.Name -ine 'conhost.exe' -or $other.ExecutablePath -ine (Join-Path $env:SystemRoot 'System32/conhost.exe')){throw 'OWNED_GO_CHILD_COMMAND_CHANGED'}
  }
  foreach($child in $workers){
    $handle=[OwnedEgoFault]::OpenProcess(0x800,$false,[int]$child.ProcessId)
    if($handle -eq [IntPtr]::Zero){throw 'OWNED_WORKER_HANDLE_DENIED'}
    try{if([OwnedEgoFault]::NtSuspendProcess($handle) -ne 0){throw 'OWNED_WORKER_SUSPEND_FAILED'}}finally{[void][OwnedEgoFault]::CloseHandle($handle)}
  }
  @{workers=@($workers | ForEach-Object {[int]$_.ProcessId});ancillary=@($ancillary | ForEach-Object {[int]$_.ProcessId})} | ConvertTo-Json -Compress
  exit 0
}
$access=if($Mode -eq 'Terminate'){1}else{0x800}
$handle=[OwnedEgoFault]::OpenProcess($access,$false,$TargetProcessId)
if($handle -eq [IntPtr]::Zero){throw 'OWNED_PROCESS_HANDLE_DENIED'}
try{
  if($Mode -eq 'Suspend'){$result=[OwnedEgoFault]::NtSuspendProcess($handle)}
  elseif($Mode -eq 'Resume'){$result=[OwnedEgoFault]::NtResumeProcess($handle)}
  else{if(![OwnedEgoFault]::TerminateProcess($handle,91)){throw 'OWNED_PROCESS_TERMINATION_FAILED'};$result=0}
  if($result -ne 0){throw "OWNED_PROCESS_FAULT_FAILED_$result"}
  @{pid=$TargetProcessId;mode=$Mode;result=$result} | ConvertTo-Json -Compress
}finally{[void][OwnedEgoFault]::CloseHandle($handle)}
