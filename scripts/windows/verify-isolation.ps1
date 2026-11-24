param([Parameter(Mandatory)][int]$BrokerPid,[switch]$Production)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run from the normal desktop or Codex sandbox, never Administrator'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IsolationProbe {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$root=Join-Path $env:ProgramFiles 'PocketArchiveBroker'
$failed=$false
$files=@('agent.secret','origin.txt','runner.sid','Broker.exe')
if($Production){$files+='production.enabled'}
foreach($name in $files){
    foreach($access in @('Read','ReadWrite')){
        $handle=$null
        try{
            $handle=[IO.File]::Open((Join-Path $root $name),'Open',$access,'ReadWrite')
            "$name $access ALLOWED"
            $failed=$true
        }catch [UnauthorizedAccessException]{"$name $access DENIED"}
        finally{if($handle){$handle.Dispose()}}
    }
}
foreach($access in @(0x10,0x20,0x8,0x40,0x2,0x40000,0x80000,0x1,0x800)){
    $handle=[IsolationProbe]::OpenProcess($access,$false,$BrokerPid)
    if($handle -ne [IntPtr]::Zero){
        $null=[IsolationProbe]::CloseHandle($handle)
        "Process right $access ALLOWED"
        $failed=$true
    }elseif([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 5){throw 'Probe invalid: expected live process access denied'}
    else{"Process right $access DENIED"}
}
if($failed){throw 'Isolation failed'}
'File and memory access probes passed. IPC identity, restart and remote denial still require service integration tests.'
