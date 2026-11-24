param([Parameter(Mandatory)][ValidateSet('Prepare','Collect','Cleanup','Codex','Event','RetryCodex')][string]$Action,
    [ValidateSet('Logon','Unlock','Resume')][string]$Source)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$output=Join-Path $repo 'test-results/windows-events'
$prefix='PocketArchiveProbeEvents-'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Use a normal desktop console; tasks must not run elevated'}
Set-Location $repo
. "$PSScriptRoot/task-definition.ps1"
function Invoke-NodeProbe([string]$arguments,[string]$name){
    $process=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $output ($name+'.log')) -RedirectStandardError (Join-Path $output ($name+'.stderr.log'))
    if($process.ExitCode -ne 0){throw "$name failed (exit $($process.ExitCode)); inspect its local logs"}
}
if($Action -eq 'Event'){
    Invoke-NodeProbe ('tests/windows-event-probe.mjs '+$Source) $Source
    exit
}
if($Action -eq 'Codex'){
    $result=@{passed=$false;startedAt=[DateTime]::UtcNow.ToString('o')}
    try{
        $env:PA_CODEX_EXECUTABLE=Get-Content -LiteralPath (Join-Path $output 'codex.path') -Raw
        $env:PA_CODEX_EXECUTABLE=$env:PA_CODEX_EXECUTABLE.Trim()
        if(-not (Test-Path -LiteralPath $env:PA_CODEX_EXECUTABLE)){throw 'Recorded Codex executable is missing'}
        if(-not (Test-Path -LiteralPath (Join-Path $output 'codex-drain.passed'))){
            Invoke-NodeProbe 'tests/windows-runner.mjs --codex' 'codex-drain'
            Set-Content -LiteralPath (Join-Path $output 'codex-drain.passed') -Value 'Public batch passed; preserve its log'
        }
        Invoke-NodeProbe 'tests/windows-runner-lifecycle.mjs --codex' 'codex-reclaim'
        $result.passed=$true
    }catch{$result.error=$_.Exception.Message}
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'Codex.json') -Encoding UTF8
    if(-not $result.passed){exit 1}
    exit
}
if($Action -eq 'Prepare'){
    foreach($name in @('Logon','Unlock','Resume','Codex')){
        if(Get-ScheduledTask -TaskName ($prefix+$name) -ErrorAction SilentlyContinue){throw 'A previous probe task exists; Collect or Cleanup first'}
    }
    if(Test-Path -LiteralPath $output){throw 'Previous event evidence exists; preserve it and choose Collect instead of overwriting'}
    New-Item -ItemType Directory -Path $output | Out-Null
    Set-Content -LiteralPath (Join-Path $output 'codex.path') -Value (Get-CodexExecutable) -Encoding UTF8
    & "$PSScriptRoot/manage.ps1" Build
    $compiler="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    & $compiler /nologo /define:FIXTURE "/out:$repo\test-results\windows-build\BrokerFixture.exe" /r:System.Net.Http.dll /r:System.Web.Extensions.dll /r:System.ServiceProcess.dll "$PSScriptRoot\Broker.cs"
    if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
    . "$PSScriptRoot/task-definition.ps1"
    $created=@()
    try{
        foreach($name in @('Logon','Unlock','Resume','Codex')){
            $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$PSScriptRoot+'\probe-events.ps1" -Action Codex'
            $executable="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
            if($name -ne 'Codex'){
                $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$PSScriptRoot+'\probe-events.ps1" -Action Event -Source '+$name
            }
            [xml]$xml=Get-RunnerTaskXml -Executable $executable -Arguments $arguments -WorkingDirectory $repo -UserSid $identity.User.Value
            $kind=@{Logon='LogonTrigger';Unlock='SessionStateChangeTrigger';Resume='EventTrigger';Codex='none'}[$name]
            foreach($trigger in @($xml.Task.Triggers.ChildNodes)){if($trigger.LocalName -ne $kind){$null=$xml.Task.Triggers.RemoveChild($trigger)}}
            $null=Register-ScheduledTask -TaskName ($prefix+$name) -Xml $xml.OuterXml
            $created+=$prefix+$name
        }
        Start-ScheduledTask -TaskName ($prefix+'Codex')
    }catch{
        foreach($name in $created){Unregister-ScheduledTask -TaskName $name -Confirm:$false}
        throw
    }
    'Prepared Limited probe tasks. Wait for Codex.json before lock/sleep/sign-out; then run Collect. Installed ProbeOnly service is unchanged.'
}
if($Action -eq 'RetryCodex'){
    Set-Content -LiteralPath (Join-Path $output 'codex.path') -Value (Get-CodexExecutable) -Encoding UTF8
    Start-ScheduledTask -TaskName ($prefix+'Codex')
}
if($Action -eq 'Collect'){
    foreach($name in @('Logon','Unlock','Resume','Codex','Sleep','Sleep-reconciled')){
        $path=Join-Path $output ($name+'.json')
        if(Test-Path -LiteralPath $path){Get-Content -LiteralPath $path}else{"UNVERIFIED $name"}
    }
    Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1} -MaxEvents 2 | Select-Object TimeCreated,Id
}
if($Action -eq 'Cleanup'){
    foreach($name in @('Logon','Unlock','Resume','Codex')){
        if(Get-ScheduledTask -TaskName ($prefix+$name) -ErrorAction SilentlyContinue){
            Stop-ScheduledTask -TaskName ($prefix+$name) -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName ($prefix+$name) -Confirm:$false
        }
    }
    'Temporary event probes removed; evidence preserved.'
}
