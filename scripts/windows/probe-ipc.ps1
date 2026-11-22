param([Parameter(Mandatory)][int]$ExpectedPid)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run from the normal desktop or Codex sandbox'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PipeIdentityProbe {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr handle,out uint pid);
}
'@
$rights=[IO.Pipes.PipeAccessRights]::ReadData -bor [IO.Pipes.PipeAccessRights]::WriteData -bor [IO.Pipes.PipeAccessRights]::ReadAttributes -bor [IO.Pipes.PipeAccessRights]::ReadPermissions
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.', 'PocketArchiveBroker', $rights,
    [IO.Pipes.PipeOptions]::Asynchronous, [Security.Principal.TokenImpersonationLevel]::Anonymous,
    [IO.HandleInheritability]::None)
try{
    $pipe.Connect(2000)
    $serverPid=[uint32]0
    if(-not [PipeIdentityProbe]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$serverPid)){throw 'Cannot verify pipe PID'}
    if($serverPid -ne $ExpectedPid){throw 'Pipe PID mismatch'}
    $owner=$pipe.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier])
    $expected=([Security.Principal.NTAccount]::new('NT SERVICE\PocketArchiveBroker')).Translate([Security.Principal.SecurityIdentifier])
    if($owner -ne $expected){throw 'Pipe owner mismatch'}
    # Opcode zero is rejected before claim; no backend request or credential use.
    $pipe.WriteByte(0)
    $buffer=[byte[]]::new(1)
    $read=$pipe.ReadAsync($buffer,0,1)
    if(-not $read.Wait(5000)){throw 'Invalid opcode did not close within five seconds'}
    if($read.Result -ne 0){throw 'Unexpected protocol response'}
    "PASS pipe PID=$serverPid, service owner verified, invalid opcode rejected"
}finally{$pipe.Dispose()}
