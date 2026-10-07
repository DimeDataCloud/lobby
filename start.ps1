<#
.SYNOPSIS
    Start (or stop) the Lobby stack on Windows: Bun server + Vite dashboard.

.DESCRIPTION
    Replaces start.sh / the justfile, neither of which works on this box:
    `just` is not installed, the .sh scripts need bash, and `open` is not a
    Windows command.

    Vite is launched via node against vite/bin/vite.js rather than npm.cmd.
    Killing an npm.cmd shim orphans the real Vite process; killing node does not.

.EXAMPLE
    .\start.ps1            # start both, health-check, print URLs
    .\start.ps1 -Stop      # stop whatever start.ps1 started
    .\start.ps1 -Force     # stop anything already on the ports, then start
#>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$Force,
    [int]$ServerPort = 4000,
    [int]$ClientPort = 5173
)

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PidDir = Join-Path $Root '.pids'
$LogDir = Join-Path $Root 'logs'

foreach ($d in @($PidDir, $LogDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---------- helpers ----------

function Get-BunPath {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Get-ListenerPid {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -First 1
        if ($null -ne $conn) { return $conn.OwningProcess }
    } catch {}
    return $null
}

function Wait-ForHttp {
    param([string]$Url, [int]$TimeoutSec = 25)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}

function Save-Pid {
    param([string]$Name, [int]$ProcessId)
    Set-Content -Path (Join-Path $PidDir "$Name.pid") -Value $ProcessId -Encoding ascii
}

function Stop-Tracked {
    param([string]$Name)
    $f = Join-Path $PidDir "$Name.pid"
    if (-not (Test-Path $f)) { return $false }
    $tracked = (Get-Content $f -Raw).Trim()
    Remove-Item $f -Force
    if ([string]::IsNullOrWhiteSpace($tracked)) { return $false }
    try {
        Stop-Process -Id ([int]$tracked) -Force -ErrorAction Stop
        Write-Host ("  stopped {0} (pid {1})" -f $Name, $tracked)
        return $true
    } catch {
        return $false
    }
}

function Stop-Stack {
    Write-Host 'Stopping Lobby stack...'
    $any = $false
    if (Stop-Tracked 'client') { $any = $true }
    if (Stop-Tracked 'server') { $any = $true }
    if (-not $any) { Write-Host '  nothing tracked was running' }
}

# ---------- stop mode ----------

if ($Stop) {
    Stop-Stack
    return
}

# ---------- preflight ----------

$bun = Get-BunPath
if ($null -eq $bun) {
    Write-Error 'bun not found. Install from https://bun.sh or ensure ~\.bun\bin\bun.exe exists.'
    return
}

$viteJs = Join-Path $Root 'apps\client\node_modules\vite\bin\vite.js'
if (-not (Test-Path $viteJs)) {
    Write-Error "Vite not installed. Run: cd apps\client; npm install"
    return
}

$serverBusy = Get-ListenerPid -Port $ServerPort
$clientBusy = Get-ListenerPid -Port $ClientPort

if ($null -ne $serverBusy -and -not $Force) {
    Write-Host ("Port {0} already has a listener (pid {1})." -f $ServerPort, $serverBusy) -ForegroundColor Yellow
    Write-Host '  Leaving it alone. Use -Force to replace it, or -Stop first.' -ForegroundColor Yellow
} elseif ($null -ne $serverBusy -and $Force) {
    Write-Host ("Force: killing pid {0} on port {1}" -f $serverBusy, $ServerPort) -ForegroundColor Yellow
    try { Stop-Process -Id $serverBusy -Force -ErrorAction Stop } catch {}
    Start-Sleep -Milliseconds 600
    $serverBusy = $null
}

if ($null -ne $clientBusy -and $Force) {
    try { Stop-Process -Id $clientBusy -Force -ErrorAction Stop } catch {}
    Start-Sleep -Milliseconds 400
    $clientBusy = $null
}

# ---------- server ----------

if ($null -eq $serverBusy) {
    Write-Host ("Starting server on http://localhost:{0}" -f $ServerPort)
    $srv = Start-Process -FilePath $bun `
        -ArgumentList 'run', 'src/index.ts' `
        -WorkingDirectory (Join-Path $Root 'apps\server') `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'server.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'server.err.log')
    Save-Pid 'server' $srv.Id

    if (Wait-ForHttp -Url ("http://localhost:{0}/health" -f $ServerPort)) {
        Write-Host '  server up' -ForegroundColor Green
    } else {
        Write-Host '  server did NOT come up — see logs\server.err.log' -ForegroundColor Red
        Get-Content (Join-Path $LogDir 'server.err.log') -Tail 20 -ErrorAction SilentlyContinue
        Stop-Tracked 'server' | Out-Null
        return
    }
} else {
    Write-Host ("Reusing server already on port {0}" -f $ServerPort) -ForegroundColor Green
}

# ---------- client ----------

if ($null -eq $clientBusy) {
    Write-Host ("Starting dashboard on http://localhost:{0}" -f $ClientPort)
    $cli = Start-Process -FilePath 'node' `
        -ArgumentList $viteJs, '--port', $ClientPort, '--strictPort' `
        -WorkingDirectory (Join-Path $Root 'apps\client') `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'client.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'client.err.log')
    Save-Pid 'client' $cli.Id

    if (Wait-ForHttp -Url ("http://localhost:{0}/" -f $ClientPort)) {
        Write-Host '  dashboard up' -ForegroundColor Green
    } else {
        Write-Host '  dashboard did NOT come up — see logs\client.err.log' -ForegroundColor Red
        Get-Content (Join-Path $LogDir 'client.err.log') -Tail 20 -ErrorAction SilentlyContinue
        return
    }
} else {
    Write-Host ("Reusing dashboard already on port {0}" -f $ClientPort) -ForegroundColor Green
}

# ---------- summary ----------

Write-Host ''
Write-Host '  Lobby is running' -ForegroundColor Cyan
Write-Host ('  Dashboard : http://localhost:{0}' -f $ClientPort)
Write-Host ('  Server    : http://localhost:{0}' -f $ServerPort)
Write-Host ('  WebSocket : ws://localhost:{0}/stream' -f $ServerPort)
Write-Host ''
Write-Host '  Stop with: .\start.ps1 -Stop'
Write-Host ''
