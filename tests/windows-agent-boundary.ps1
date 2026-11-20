# Fake-only manual Windows probe; not a production credential broker.
param(
    [Parameter(Mandatory)][ValidateSet('host', 'probe')][string]$Mode,
    [Parameter(Mandatory)][string]$StatePath,
    [string]$SandboxSid,
    [switch]$HardenProcess
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows PowerShell 7 required' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BoundaryNative {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,
        uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, IntPtr descriptor);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer,
        int count, out IntPtr read);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafePipeHandle CreateFile(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ownerSid = $identity.User.Value
if ($Mode -eq 'host') {
    if (-not $SandboxSid -or $SandboxSid -eq $ownerSid) { throw 'A different sandbox SID is required' }
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('pa-boundary-' + [guid]::NewGuid().ToString('N'))
    $pipeName = 'pa-boundary-' + [guid]::NewGuid().ToString('N')
    $pipe = $null
    $sentinel = [IntPtr]::Zero
    try {
        if ($HardenProcess) {
            $descriptor = [IntPtr]::Zero
            $size = [uint32]0
            if (-not [BoundaryNative]::ConvertStringSecurityDescriptorToSecurityDescriptor(
                "D:P(A;;GA;;;${ownerSid})(A;;GA;;;SY)", 1, [ref]$descriptor, [ref]$size)) { throw 'Process SDDL failed' }
            try {
                if (-not [BoundaryNative]::SetKernelObjectSecurity([IntPtr]::new(-1), 4, $descriptor)) { throw 'Process DACL failed' }
            } finally { $null = [BoundaryNative]::LocalFree($descriptor) }
        }
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetSecurityDescriptorSddlForm("O:${ownerSid}G:${ownerSid}D:P(A;OICI;FA;;;${ownerSid})(A;OICI;FA;;;SY)")
        $null = [IO.FileSystemAclExtensions]::CreateDirectory($acl, $directory)
        $fake = 'FAKE-NOT-A-CREDENTIAL-' + [guid]::NewGuid().ToString('N')
        $sentinel = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($fake)
        $fakeBytes = [Text.Encoding]::Unicode.GetBytes($fake)
        [IO.File]::WriteAllText((Join-Path $directory 'credential.fake'), $fake)
        [IO.File]::WriteAllText((Join-Path $directory 'runner.fake'), 'fixed probe operation only')
        $pipeAcl = [IO.Pipes.PipeSecurity]::new()
        # Specific data rights omit FILE_CREATE_PIPE_INSTANCE; network identities denied.
        $pipeAcl.SetSecurityDescriptorSddlForm("D:P(D;;GA;;;NU)(A;;GA;;;${ownerSid})(A;;0x100003;;;${SandboxSid})")
        $pipe = [IO.Pipes.NamedPipeServerStreamAcl]::Create($pipeName, [IO.Pipes.PipeDirection]::InOut,
            1, [IO.Pipes.PipeTransmissionMode]::Message, [IO.Pipes.PipeOptions]::Asynchronous,
            1024, 1024, $pipeAcl)
        @{
            pid = $PID; ownerSid = $ownerSid; sandboxSid = $SandboxSid; directory = $directory
            hardenedProcess = [bool]$HardenProcess
            pipe = $pipeName; fileSddl = (Get-Acl -LiteralPath $directory).Sddl
            sentinelAddress = $sentinel.ToInt64(); sentinelLength = $fakeBytes.Length
            sentinelSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($fakeBytes))
            pipeSddl = $pipeAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
        } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
        $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(5))
        # Three bounded requests from each identity; no backend, shell, token or file operations.
        for ($i = 0; $i -lt 6; $i++) {
            $pipe.WaitForConnectionAsync($deadline.Token).GetAwaiter().GetResult()
            $bytes = [byte[]]::new(257)
            $count = $pipe.ReadAsync($bytes, 0, $bytes.Length, $deadline.Token).GetAwaiter().GetResult()
            $request = [Text.Encoding]::UTF8.GetString($bytes, 0, $count)
            $response = if ($request -ceq '{"op":"status"}') { '{"ok":true}' } else { '{"error":"operation_denied"}' }
            $output = [Text.Encoding]::UTF8.GetBytes($response)
            $pipe.WriteAsync($output, 0, $output.Length, $deadline.Token).GetAwaiter().GetResult()
            $pipe.WaitForPipeDrain()
            $pipe.Disconnect()
        }
    } finally {
        if ($pipe) { $pipe.Dispose() }
        if ($sentinel -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($sentinel) }
        # Only this process's freshly generated test directory can be removed.
        $resolved = [IO.Path]::GetFullPath($directory)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolved) -match '^pa-boundary-[a-f0-9]{32}$') {
            if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
        } else { throw 'Refusing unsafe cleanup path' }
    }
    exit
}
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$results = [ordered]@{ identitySid = $ownerSid; hostSid = $state.ownerSid; hardenedProcess = $state.hardenedProcess }
foreach ($file in @('credential.fake', 'runner.fake')) {
    foreach ($access in @('Read', 'ReadWrite')) {
        $handle = $null
        try {
            $handle = [IO.File]::Open((Join-Path $state.directory $file), 'Open', $access, 'ReadWrite')
            if ($access -eq 'Read') { $null = $handle.ReadByte() }
            $results["$file/$access"] = $true
        } catch [UnauthorizedAccessException] { $results["$file/$access"] = $false }
        finally { if ($handle) { $handle.Dispose() } }
    }
}
foreach ($entry in @{ VM_READ = 0x10; VM_WRITE = 0x20; VM_OPERATION = 0x8; DUP_HANDLE = 0x40; QUERY_LIMITED = 0x1000 }.GetEnumerator()) {
    $handle = [BoundaryNative]::OpenProcess($entry.Value, $false, $state.pid)
    $results["process/$($entry.Key)"] = $handle -ne [IntPtr]::Zero
    if ($handle -ne [IntPtr]::Zero) { $null = [BoundaryNative]::CloseHandle($handle) }
}
if ($state.sentinelLength -le 0 -or $state.sentinelLength -gt 256) { throw 'Invalid fake sentinel length' }
$handle = [BoundaryNative]::OpenProcess(0x10, $false, $state.pid)
try {
    $bytes = [byte[]]::new($state.sentinelLength)
    $read = [IntPtr]::Zero
    $ok = [BoundaryNative]::ReadProcessMemory($handle, [IntPtr]::new($state.sentinelAddress), $bytes, $bytes.Length, [ref]$read)
    $results['process/fakeCredentialReadVerified'] = $ok -and $read.ToInt64() -eq $bytes.Length -and
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)) -ceq $state.sentinelSha
} finally { if ($handle -ne [IntPtr]::Zero) { $null = [BoundaryNative]::CloseHandle($handle) } }
foreach ($request in @('{"op":"status"}', '{"op":"fetch","url":"https://example.com"}', '{"op":"shell","command":"whoami"}')) {
    $handle = [BoundaryNative]::CreateFile('\\.\pipe\' + $state.pipe, 3, 0, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    if ($handle.IsInvalid) {
        $results['ipc/connectError'] = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        break
    }
    $client = [IO.Pipes.NamedPipeClientStream]::new([IO.Pipes.PipeDirection]::InOut, $false, $true, $handle)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($request)
        $client.Write($bytes, 0, $bytes.Length)
        $buffer = [byte[]]::new(256)
        $count = $client.Read($buffer, 0, $buffer.Length)
        $response = [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
        $expected = if ($request -ceq '{"op":"status"}') { '{"ok":true}' } else { '{"error":"operation_denied"}' }
        if ($response -cne $expected) { throw 'Fixed interface self-check failed' }
        $results["ipc/" + ($request | ConvertFrom-Json).op] = $response
    } finally { $client.Dispose() }
    Start-Sleep -Milliseconds 100
}
$results | ConvertTo-Json
