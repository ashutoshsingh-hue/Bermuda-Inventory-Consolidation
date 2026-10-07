<#
 Bermuda Sort Station - one-time setup for the always-on wired host PC.
 Run in PowerShell AS ADMINISTRATOR, from the project folder:
     powershell -ExecutionPolicy Bypass -File deploy\setup-host.ps1
 Safe to re-run. It: installs dependencies, opens the firewall, makes the HTTPS certificate
 (needed for the phone camera) and registers a startup task that restarts the server if it dies.
#>
param(
  [string]$TaskName = 'BermudaSortStation',
  [int]$Port = 8080
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this PowerShell window as Administrator.' }

# 1. Node + dependencies
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node 20+ is not installed. Install it from nodejs.org (LTS), then re-run.' }
if ([int]((node -v) -replace '^v(\d+).*','$1') -lt 20) { throw "Node 20+ required, found $(node -v)." }
Write-Host "Node $(node -v) at $node"
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

# 2. Firewall: allow the app port on every profile (domain policy may still override - see deploy\README.md)
Get-NetFirewallRule -DisplayName 'Bermuda Sort Station' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Bermuda Sort Station' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
Write-Host "Firewall: inbound TCP $Port allowed"

# 3. HTTPS certificate covering this PC's name and every IPv4 address
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
  foreach ($p in 'C:\Program Files\Git\usr\bin\openssl.exe','C:\Program Files\OpenSSL-Win64\bin\openssl.exe') { if (Test-Path $p) { $openssl = $p; break } }
}
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | ForEach-Object IPAddress
$host_ = $env:COMPUTERNAME.ToLower()
$fqdn = try { [System.Net.Dns]::GetHostEntry('').HostName.ToLower() } catch { $host_ }
$san = @("DNS:$host_","DNS:$fqdn",'DNS:localhost') + ($ips | ForEach-Object { "IP:$_" }) | Select-Object -Unique
New-Item -ItemType Directory -Force certs | Out-Null
if ($openssl) {
  & $openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs\key.pem -out certs\cert.pem -subj "/CN=$host_" -addext ("subjectAltName=" + ($san -join ',')) 2>$null
  Write-Host "Certificate made for: $($san -join ', ')"
} else {
  Write-Warning 'openssl not found (install Git for Windows). Skipping certificate: server will run plain HTTP, no phone camera.'
}

# 4. Startup task: runs at boot as SYSTEM, restarts on failure, logs to server.log
$cmd = "cd /d `"$root`" && `"$node`" src\server.js >> server.log 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $cmd" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
Write-Host "Startup task '$TaskName' registered"

# 5. Power: never sleep on AC (a sleeping host drops every station)
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Start-ScheduledTask -TaskName $TaskName
Start-Sleep 5
$ok = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($ok) {
  Write-Host "`nServer is up. Open from other PCs:"
  Write-Host "  http://${host_}:$Port/station/   (or http://$($ips | Select-Object -First 1):$Port/station/)"
  Write-Host "  Admin: http://${host_}:$Port/admin/"
  Write-Host "  Phones (camera): https://${host_}:$Port/station/"
} else { Write-Warning 'Server did not start - read server.log' }
