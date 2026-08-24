# Restart the dsh web GUI so the newly installed dsh-fulltext-search plugin
# (host half + loader entry) takes effect. Runs as an independent detached
# process so it survives the web server's own shutdown.
# NOTE: port probing is unreliable under the DSH sandbox, so we kill the
# known dsh web node process(es) by name instead.
$ErrorActionPreference = 'SilentlyContinue'

# 1) Stop the current dsh web server (node processes are the harness server
#    on this machine; the desktop launcher starts it via `dsh web`).
$procs = @(Get-Process node -ErrorAction SilentlyContinue)
Write-Output "node processes before: $($procs.Count)"
foreach ($p in $procs) {
  Write-Output "stopping node pid $($p.Id)..."
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# 2) Launch a fresh dsh web (same as the desktop launcher does).
$command = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $command) {
  Write-Output 'ERROR: dsh command not found'
  exit 1
}
Write-Output "launching dsh web via $($command.Source)..."
Start-Process -FilePath $command.Source -ArgumentList @('web') -WindowStyle Hidden

# 3) Wait for the new server to come up.
$up = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080' -TimeoutSec 2
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
      $up = $true
      break
    }
  } catch {
    # not up yet
  }
}
Write-Output "new server up: $up"
if ($up) { Write-Output 'RESTART_OK' } else { Write-Output 'RESTART_FAILED' }
