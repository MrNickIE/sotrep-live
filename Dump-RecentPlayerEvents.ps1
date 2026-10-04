# Dump-RecentPlayerEvents.ps1
# Runs the same ETW capture the old SOTREP script used, for 90 seconds,
# then writes every captured event to a text file so we can see what the
# game is actually sending today. Run as Administrator while in a game
# session with other crews nearby.
#
# Output: a folder called sotrep-debug on your Desktop.

$ErrorActionPreference = 'Continue'
$OutDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'sotrep-debug'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$Stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$Etl    = Join-Path $OutDir "capture-$Stamp.etl"
$Txt    = Join-Path $OutDir "events-$Stamp.txt"
$Seconds = 90

if (Get-NetEventSession -ErrorAction SilentlyContinue) {
    Get-NetEventSession | Stop-NetEventSession -ErrorAction SilentlyContinue
    Get-NetEventSession | Remove-NetEventSession -ErrorAction SilentlyContinue
}

$Sesh = New-NetEventSession -Name 'SOTREP_DEBUG' -LocalFilePath $Etl -CaptureMode SaveToFile
Add-NetEventProvider -SessionName $Sesh.Name -Name 'Microsoft-Windows-WebIO' -Level 0 -MatchAllKeyword 0x20100000000 | Out-Null
$Sesh | Start-NetEventSession

Write-Host "Capturing WebIO events for $Seconds seconds - sail near another crew now..." -ForegroundColor Yellow
for ($i = $Seconds; $i -gt 0; $i--) { Write-Host -NoNewline "`r$i  "; Start-Sleep -Seconds 1 }
Write-Host ''

$Sesh | Stop-NetEventSession
$Sesh | Remove-NetEventSession

$Events = @(Get-WinEvent -Path $Etl -Oldest -ErrorAction SilentlyContinue)
"Captured $($Events.Count) events at $Stamp" | Set-Content $Txt
'' | Add-Content $Txt
foreach ($e in $Events) {
    "===== $($e.TimeCreated.ToString('HH:mm:ss.fff')) Id=$($e.Id) Task=$($e.TaskDisplayName) Pid=$($e.ProcessId)" | Add-Content $Txt
    $e.Message | Add-Content $Txt
    try {
        $xml = [xml]$e.ToXml()
        foreach ($d in $xml.Event.EventData.Data) { "  [$($d.Name)] $($d.'#text')" | Add-Content $Txt }
    } catch {}
    '' | Add-Content $Txt
}

# Quick summary of anything that looks like Xbox Live traffic
$Hits = $Events | Where-Object { $_.Message -match 'xboxlive|recentplayers|peoplehub|xuid|seaofthieves|athena' }
"" | Add-Content $Txt
"Xbox-looking events: $($Hits.Count)" | Add-Content $Txt
Write-Host "Done. $($Events.Count) events captured, $($Hits.Count) look Xbox-related." -ForegroundColor Green
Write-Host "Written to: $Txt" -ForegroundColor Green
Write-Host "The .etl is kept alongside it in case we need to re-parse."
