param([Parameter(Mandatory)][int]$ExpectedPid)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run from the normal desktop, never Administrator'}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$name='PocketArchiveProbe-'+[guid]::NewGuid().ToString('N')
$directory=Join-Path $repo ('test-results/'+$name)
New-Item -ItemType Directory -Path $directory | Out-Null
$wrapper=Join-Path $directory 'probe.ps1'
$log=Join-Path $directory 'result.txt'
function Literal([string]$value){return "'"+$value.Replace("'","''")+"'"}
# The temporary task only probes opcode zero and access denial; it never starts the Runner or claims work.
$body=@(
    '$ErrorActionPreference=''Stop''',
    ('& '+(Literal (Join-Path $PSScriptRoot 'probe-ipc.ps1'))+' -ExpectedPid '+$ExpectedPid+' *> '+(Literal $log)),
    ('& '+(Literal (Join-Path $PSScriptRoot 'verify-isolation.ps1'))+' -BrokerPid '+$ExpectedPid+' *>> '+(Literal $log))
)
Set-Content -LiteralPath $wrapper -Value $body -Encoding UTF8
$created=$false
try{
    $action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -File "'+$wrapper+'"') -WorkingDirectory $repo
    $taskPrincipal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
    $null=Register-ScheduledTask -TaskName $name -Action $action -Principal $taskPrincipal -Trigger $trigger -Settings $settings
    $created=$true
    $task=Get-ScheduledTask -TaskName $name
    if($task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Interactive' -or $task.Settings.MultipleInstances -ne 'IgnoreNew'){throw 'Task security settings mismatch'}
    Start-ScheduledTask -TaskName $name
    $until=[DateTime]::UtcNow.AddSeconds(30)
    do{
        Start-Sleep -Milliseconds 300
        $info=Get-ScheduledTaskInfo -TaskName $name
        $state=(Get-ScheduledTask -TaskName $name).State
    }while(($info.LastRunTime.Year -lt 2000 -or $state -eq 'Running') -and [DateTime]::UtcNow -lt $until)
    if($info.LastRunTime.Year -lt 2000 -or $state -eq 'Running' -or $info.LastTaskResult -ne 0){throw "Scheduled probe failed: state=$state result=$($info.LastTaskResult). See $log"}
    $output=Get-Content -LiteralPath $log -Raw
    if($output -notmatch 'PASS pipe PID=' -or $output -notmatch 'File and memory access probes passed'){throw 'Scheduled probe output incomplete'}
    $output
    'PASS Limited interactive scheduled execution; actual logon/boot trigger remains unverified'
}finally{
    if($created){
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
}
