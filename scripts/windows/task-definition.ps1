function Get-CodexExecutable {
    $command=Get-Command codex.exe -ErrorAction SilentlyContinue
    if($command){return $command.Source}
    # Codex Desktop bundles its CLI but does not necessarily add it to the desktop PATH.
    $root=Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin'
    $candidate=Get-ChildItem -LiteralPath $root -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if(-not $candidate){throw 'Codex CLI not found in PATH or the Codex Desktop installation'}
    return $candidate.FullName
}
function Get-RunnerTaskXml {
    param([Parameter(Mandatory)][string]$Executable,[Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,[Parameter(Mandatory)][string]$UserSid)
    $null=[Security.Principal.SecurityIdentifier]::new($UserSid)
    $command=[Security.SecurityElement]::Escape($Executable)
    $argument=[Security.SecurityElement]::Escape($Arguments)
    $directory=[Security.SecurityElement]::Escape($WorkingDirectory)
    $subscription=[Security.SecurityElement]::Escape('<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>')
    @"
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Pocket Archive event-triggered queue drain; no periodic polling.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$UserSid</UserId><Delay>PT15S</Delay></LogonTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><UserId>$UserSid</UserId><Delay>PT15S</Delay><StateChange>SessionUnlock</StateChange></SessionStateChangeTrigger>
    <EventTrigger><Enabled>true</Enabled><Subscription>$subscription</Subscription><Delay>PT30S</Delay></EventTrigger>
  </Triggers>
  <Principals><Principal id="Desktop"><UserId>$UserSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="Desktop"><Exec><Command>$command</Command><Arguments>$argument</Arguments><WorkingDirectory>$directory</WorkingDirectory></Exec></Actions>
</Task>
"@
}
