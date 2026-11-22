param([Parameter(Mandatory)][ValidateSet('Build','Install','Inspect','Uninstall','UpdateProbe','EnableRunner','Start','Stop','DisableRunner')][string]$Action,
    [string]$Origin,[string]$RunnerSid,[switch]$ProbeOnly)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$build=Join-Path $repo 'test-results/windows-build'
$installed=Join-Path $env:ProgramFiles 'PocketArchiveBroker'
$service='PocketArchiveBroker'
$task='PocketArchiveRunner'
function Native($program,$arguments) {
    & $program @arguments
    if($LASTEXITCODE -ne 0){ throw "$program failed ($LASTEXITCODE)" }
}
if($Action -eq 'Build'){
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $compiler="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    Native $compiler @('/nologo',"/out:$build\Broker.exe",'/r:System.Net.Http.dll','/r:System.Web.Extensions.dll','/r:System.ServiceProcess.dll',"$PSScriptRoot\Broker.cs")
    Native $compiler @('/nologo',"/out:$build\Runner.exe","$PSScriptRoot\Runner.cs")
    Get-FileHash "$build\Broker.exe","$build\Runner.exe"
    exit
}
if($Action -in @('Install','Uninstall','UpdateProbe')){
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run manually in an Administrator console after reviewing this script'}
}
if($Action -eq 'UpdateProbe'){
    $configuration=Get-CimInstance Win32_Service -Filter "Name='PocketArchiveBroker'"
    if($configuration.StartName -ne "NT SERVICE\$service" -or $configuration.PathName.Trim('"') -ne "$installed\Broker.exe" -or $configuration.StartMode -ne 'Manual'){throw 'Unexpected service configuration; inspect manually'}
    if([IO.File]::ReadAllText("$installed\origin.txt").Trim() -ne 'https://pocket-archive-isolation.invalid'){throw 'Only ProbeOnly installations may be updated'}
    if([IO.File]::ReadAllText("$installed\agent.secret").Trim() -ne ('pa_agent_probe0001.'+('x'*40))){throw 'Expected fixed fake credential; update refused'}
    if(Test-Path -LiteralPath "$installed\Broker.previous.exe"){throw 'Previous backup exists; inspect before another update'}
    $expected=(Get-FileHash "$build\Broker.exe").Hash
    Stop-Service $service
    Copy-Item -LiteralPath "$installed\Broker.exe" -Destination "$installed\Broker.previous.exe"
    Copy-Item -LiteralPath "$build\Broker.exe" -Destination "$installed\Broker.exe" -Force
    Native icacls.exe @("$installed\Broker.exe",'/setowner','*S-1-5-18')
    Native icacls.exe @("$installed\Broker.previous.exe",'/setowner','*S-1-5-18')
    if((Get-FileHash "$installed\Broker.exe").Hash -ne $expected){throw 'Installed binary hash mismatch; service left stopped'}
    Start-Service $service
    Get-CimInstance Win32_Service -Filter "Name='PocketArchiveBroker'" | Select-Object State,ProcessId,StartName,StartMode
    Get-FileHash "$installed\Broker.exe"
    exit
}
if($Action -eq 'Install'){
    if($ProbeOnly){$Origin='https://pocket-archive-isolation.invalid'}
    $uri=[uri]$Origin
    if($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.UserInfo -or $uri.Fragment -or $uri.DnsSafeHost -eq 'pocket-archive.goma555416.workers.dev'){throw 'Isolated HTTPS origin required'}
    $null=[Security.Principal.SecurityIdentifier]::new($RunnerSid)
    if((Test-Path $installed) -or (Get-Service $service -ErrorAction SilentlyContinue)){throw 'Existing installation requires inspection'}
    New-Item -ItemType Directory -Path $installed | Out-Null
    Native icacls.exe @($installed,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
    Copy-Item "$build\Broker.exe" "$installed\Broker.exe"
    Native sc.exe @('create',$service,'binPath=',('"'+"$installed\Broker.exe"+'"'),'start=','disabled','obj=',"NT SERVICE\$service")
    $sid=([Security.Principal.NTAccount]::new("NT SERVICE\$service")).Translate([Security.Principal.SecurityIdentifier]).Value
    Native icacls.exe @($installed,'/grant',("*"+$sid+':(OI)(CI)RX'))
    Set-Content "$installed\origin.txt" $uri.GetLeftPart([UriPartial]::Authority) -Encoding ascii
    Set-Content "$installed\runner.sid" $RunnerSid -Encoding ascii
    New-Item -ItemType File -Path "$installed\agent.secret" | Out-Null
    Native icacls.exe @($installed,'/setowner','*S-1-5-18','/T')
    if($ProbeOnly){
        [IO.File]::WriteAllText("$installed\agent.secret",'pa_agent_probe0001.'+('x'*40))
    }else{
        $secret=Read-Host 'Isolated backend credential (never production)' -AsSecureString
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try { [IO.File]::WriteAllText("$installed\agent.secret",[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    Native sc.exe @('sidtype',$service,'unrestricted')
    Native sc.exe @('privs',$service,'SeChangeNotifyPrivilege')
    Native sc.exe @('sdset',$service,'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)')
    Write-Output 'Installed disabled. Inspect ACLs before manually enabling the service.'
}
if($Action -eq 'Inspect'){
    Native sc.exe @('qc',$service)
    Native sc.exe @('qsidtype',$service)
    Native sc.exe @('qprivs',$service)
    Native sc.exe @('sdshow',$service)
    Get-Acl $installed,"$installed\Broker.exe","$installed\agent.secret" | Select-Object Path,Owner,Sddl
}
if($Action -eq 'Uninstall'){
    if(Get-Service $service -ErrorAction SilentlyContinue){
        Stop-Service $service
        Native sc.exe @('delete',$service)
    }
    if([IO.Path]::GetFullPath($installed) -ne (Join-Path $env:ProgramFiles 'PocketArchiveBroker')){throw 'Unsafe cleanup'}
    if(Test-Path -LiteralPath $installed){Remove-Item -LiteralPath $installed -Recurse -Force}
}
if($Action -eq 'EnableRunner'){
    if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'Task already exists'}
    $sid=([Security.Principal.NTAccount]::new("NT SERVICE\$service")).Translate([Security.Principal.SecurityIdentifier]).Value
    $node=(Get-Command node.exe).Source
    $arguments='"'+$repo+'" "'+$node+'" "'+$service+'" "'+$sid+'"'
    $execute=New-ScheduledTaskAction -Execute "$build\Runner.exe" -Argument $arguments -WorkingDirectory $repo
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $task -Action $execute -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}
if($Action -eq 'Start'){
    $stop=Join-Path $repo 'private-data/runner.stop'
    if(Test-Path $stop){Remove-Item -LiteralPath $stop}
    Start-ScheduledTask -TaskName $task
}
if($Action -eq 'Stop'){
    New-Item -ItemType Directory -Force (Join-Path $repo 'private-data') | Out-Null
    Set-Content (Join-Path $repo 'private-data/runner.stop') 'Stop after current batch'
}
if($Action -eq 'DisableRunner'){
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
}
