param([Parameter(Mandatory)][ValidateSet('Build','Install','Inspect','Uninstall','UpdateProbe','PromoteProduction','RestoreProbe','EnableRunner','Start','RunOnce','Stop','DisableRunner')][string]$Action,
    [string]$Origin,[string]$RunnerSid,[switch]$ProbeOnly,[string]$BrokerHash)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$build=Join-Path $repo 'test-results/windows-build'
$installed=Join-Path $env:ProgramFiles 'PocketArchiveBroker'
$service='PocketArchiveBroker'
$task='PocketArchiveRunner'
. "$PSScriptRoot/task-definition.ps1"
function Native($program,$arguments) {
    & $program @arguments
    if($LASTEXITCODE -ne 0){ throw "$program failed ($LASTEXITCODE)" }
}
if($Action -eq 'Build'){
    New-Item -ItemType Directory -Force -Path $build | Out-Null
    $compiler="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    Native $compiler @('/nologo',"/out:$build\Broker.exe",'/r:System.Net.Http.dll','/r:System.Web.Extensions.dll','/r:System.ServiceProcess.dll',"$PSScriptRoot\Broker.cs")
    Native $compiler @('/nologo','/target:winexe',"/out:$build\Runner.exe","$PSScriptRoot\Runner.cs")
    Get-FileHash "$build\Broker.exe","$build\Runner.exe"
    exit
}
if($Action -in @('Install','Uninstall','UpdateProbe','PromoteProduction','RestoreProbe')){
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run manually in an Administrator console after reviewing this script'}
}
if($Action -in @('PromoteProduction','RestoreProbe')){
    if(-not (Test-Path -LiteralPath (Join-Path $repo 'private-data/runner.stop'))){throw 'Run manage.ps1 Stop first; do not change an active broker'}
    $cutoverMutex=[Threading.Mutex]::new($false,'Local\PocketArchiveRunner')
    try{$ownsMutex=$cutoverMutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
    if(-not $ownsMutex){$cutoverMutex.Dispose();throw 'Runner is still active; wait for it to drain'}
    try{
    $production='https://pocket-archive.goma555416.workers.dev'
    $backup=Join-Path $installed 'probe-backup'
    $configuration=Get-CimInstance Win32_Service -Filter "Name='PocketArchiveBroker'"
    if($configuration.StartName -ne "NT SERVICE\$service" -or $configuration.PathName.Trim('"') -ne "$installed\Broker.exe"){throw 'Unexpected service identity or executable'}
    $sid=([Security.Principal.NTAccount]::new("NT SERVICE\$service")).Translate([Security.Principal.SecurityIdentifier]).Value
    function AssertProtected([string]$path){
        if((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'}
        $acl=Get-Acl -LiteralPath $path
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-18'){throw 'SYSTEM ownership required'}
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            if($rule.AccessControlType -ne 'Allow'){continue}
            $who=$rule.IdentityReference.Value
            if($who -notin @('S-1-5-18','S-1-5-32-544',$sid)){throw 'Unexpected file access principal'}
            if($who -eq $sid -and ([int]$rule.FileSystemRights -band (-bnot 0x1200a9))){throw 'Service must have read/execute access only'}
        }
    }
    AssertProtected $installed
    if(-not (Get-Acl -LiteralPath $installed).AreAccessRulesProtected){throw 'Installation must disable ACL inheritance'}
    $files=@('Broker.exe','origin.txt','runner.sid','agent.secret')
    foreach($name in $files){AssertProtected (Join-Path $installed $name)}
    $runnerTask=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if($runnerTask -and $runnerTask.State -ne 'Disabled'){throw 'Disable the Runner task before changing the broker'}
    if($Action -eq 'PromoteProduction'){
        if($configuration.StartMode -ne 'Manual' -or (Test-Path -LiteralPath "$installed\production.enabled")){throw 'Expected Manual ProbeOnly installation'}
        if([IO.File]::ReadAllText("$installed\origin.txt").Trim() -ne 'https://pocket-archive-isolation.invalid' -or [IO.File]::ReadAllText("$installed\agent.secret").Trim() -ne ('pa_agent_probe0001.'+('x'*40))){throw 'Only the known fake ProbeOnly configuration can be promoted'}
        if($BrokerHash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash "$build\Broker.exe").Hash -ne $BrokerHash){throw 'Reviewed build SHA-256 required'}
        if(Test-Path -LiteralPath $backup){
            AssertProtected $backup
            foreach($name in $files){
                AssertProtected (Join-Path $backup $name)
                if((Get-FileHash (Join-Path $backup $name)).Hash -ne (Get-FileHash (Join-Path $installed $name)).Hash){throw 'Existing backup differs from restored ProbeOnly; inspect before promotion'}
            }
        }
        $secret=Read-Host 'New Windows production agent credential (not the Claude credential)' -AsSecureString
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        try{
            $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
            if($token -notmatch '^pa_agent_[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{32,128}$'){throw 'Invalid credential format'}
            Stop-Service $service
            if(-not (Test-Path -LiteralPath $backup)){
                New-Item -ItemType Directory -Path $backup | Out-Null
                foreach($name in $files){Copy-Item -LiteralPath (Join-Path $installed $name) -Destination (Join-Path $backup $name)}
                Native icacls.exe @($backup,'/setowner','*S-1-5-18','/T')
            }
            foreach($name in $files){AssertProtected (Join-Path $backup $name)}
            Copy-Item -LiteralPath "$build\Broker.exe" -Destination "$installed\Broker.exe" -Force
            if((Get-FileHash "$installed\Broker.exe").Hash -ne $BrokerHash){throw 'Installed hash mismatch; service left stopped'}
            [IO.File]::WriteAllText("$installed\origin.txt",$production)
            [IO.File]::WriteAllText("$installed\agent.secret",$token)
            [IO.File]::WriteAllText("$installed\production.enabled",$production)
            Native icacls.exe @("$installed\Broker.exe",'/setowner','*S-1-5-18')
            Native icacls.exe @("$installed\production.enabled",'/setowner','*S-1-5-18')
            foreach($name in ($files+@('production.enabled'))){AssertProtected (Join-Path $installed $name)}
        }finally{$token=$null;[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}
    }else{
        AssertProtected $backup
        foreach($name in $files){AssertProtected (Join-Path $backup $name)}
        if([IO.File]::ReadAllText("$backup\origin.txt").Trim() -ne 'https://pocket-archive-isolation.invalid' -or [IO.File]::ReadAllText("$backup\agent.secret").Trim() -ne ('pa_agent_probe0001.'+('x'*40))){throw 'Backup is not the known fake ProbeOnly configuration'}
        Stop-Service $service
        foreach($name in $files){Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $installed $name) -Force}
        if(Test-Path -LiteralPath "$installed\production.enabled"){Remove-Item -LiteralPath "$installed\production.enabled"}
        foreach($name in $files){Native icacls.exe @((Join-Path $installed $name),'/setowner','*S-1-5-18')}
    }
    # Keep Manual until the ordinary desktop and sandbox probes have passed again.
    Native sc.exe @('config',$service,'start=','demand')
    Start-Service $service
    Get-CimInstance Win32_Service -Filter "Name='PocketArchiveBroker'" | Select-Object State,ProcessId,StartName,StartMode
    Get-FileHash "$installed\Broker.exe"
    exit
    }finally{$cutoverMutex.ReleaseMutex();$cutoverMutex.Dispose()}
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
    $codex=Get-CodexExecutable
    $arguments='"'+$repo+'" "'+$node+'" "'+$service+'" "'+$sid+'" "'+$codex+'" --event'
    $xml=Get-RunnerTaskXml -Executable "$build\Runner.exe" -Arguments $arguments -WorkingDirectory $repo -UserSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    Register-ScheduledTask -TaskName $task -Xml $xml | Out-Null
}
if($Action -eq 'RunOnce'){
    $sid=([Security.Principal.NTAccount]::new("NT SERVICE\$service")).Translate([Security.Principal.SecurityIdentifier]).Value
    $node=(Get-Command node.exe).Source
    $codex=Get-CodexExecutable
    $arguments='"'+$repo+'" "'+$node+'" "'+$service+'" "'+$sid+'" "'+$codex+'"'
    $process=Start-Process -FilePath "$build\Runner.exe" -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
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
