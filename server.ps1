# Image Playground サーバー管理スクリプト
# 使い方: .\server.ps1 [start|stop|restart|status]

param(
    [Parameter(Position=0)]
    [ValidateSet("start", "stop", "restart", "status")]
    [string]$Command = "status"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $PSScriptRoot "server.pid"

function Write-ServerUrls {
    $settings = @{ PORT = $env:PORT; HTTPS_CERT_FILE = $env:HTTPS_CERT_FILE; CERT_HTTP_PORT = $env:CERT_HTTP_PORT }
    $configFile = Join-Path $PSScriptRoot '.env'
    if (Test-Path -LiteralPath $configFile) {
        foreach ($line in Get-Content -LiteralPath $configFile) {
            if ($line -match '^\s*(PORT|HTTPS_CERT_FILE|CERT_HTTP_PORT)\s*=\s*(.*?)\s*$') {
                $settingName = $Matches[1]
                if ($null -eq $settings[$settingName]) { $settings[$settingName] = $Matches[2].Trim().Trim('"', "'") }
            }
        }
    }
    $serverPort = if ($settings.PORT) { $settings.PORT } else { '8000' }
    $scheme = if ($settings.HTTPS_CERT_FILE) { 'https' } else { 'http' }
    Write-Host "URL: ${scheme}://localhost:${serverPort}"
    if (-not $settings.HTTPS_CERT_FILE) {
        Write-Host "証明書: http://localhost:${serverPort}/cert/rootCA.cer"
    } elseif ($settings.CERT_HTTP_PORT -ne 'off') {
        $downloadPort = if ($settings.CERT_HTTP_PORT) { $settings.CERT_HTTP_PORT } elseif ([int]$serverPort -gt 0 -and [int]$serverPort -lt 65535) { [int]$serverPort + 1 } else { 8001 }
        Write-Host "証明書: http://localhost:${downloadPort}/cert/rootCA.cer"
    }
}

function Get-ServerProcess {
    if (-not (Test-Path $pidFile)) { return $null }
    $storedPid = [int](Get-Content $pidFile -Raw).Trim()
    return Get-Process -Id $storedPid -ErrorAction SilentlyContinue
}

function Start-Server {
    $process = Get-ServerProcess
    if ($process) {
        Write-Host "サーバーはすでに起動しています (PID: $($process.Id))"
        Write-ServerUrls
        return
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue

    $process = Start-Process `
        -FilePath "node" `
        -ArgumentList "server.js" `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden `
        -PassThru

    $process.Id | Out-File -FilePath $pidFile -Encoding utf8 -NoNewline
    Write-Host "サーバーを起動しました (PID: $($process.Id))"
    Write-ServerUrls
}

function Stop-Server {
    if (-not (Test-Path $pidFile)) {
        Write-Host "サーバーは起動していません (PID ファイルが見つかりません)"
        return
    }
    $storedPid = [int](Get-Content $pidFile -Raw).Trim()
    $process = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    if ($process) {
        Stop-Process -Id $storedPid -Force
        Write-Host "サーバーを停止しました (PID: $storedPid)"
    } else {
        Write-Host "サーバープロセスが見つかりません (PID: $storedPid) — すでに停止済みの可能性があります"
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

function ServerStatus {
    $process = Get-ServerProcess
    if (-not (Test-Path $pidFile)) {
        Write-Host "状態: 停止中"
        exit 1
    }
    if ($process) {
        $elapsed = (Get-Date) - $process.StartTime
        $uptime = "{0}日 {1:D2}時間 {2:D2}分 {3:D2}秒" -f $elapsed.Days, $elapsed.Hours, $elapsed.Minutes, $elapsed.Seconds
        Write-Host "状態: 稼働中"
        Write-Host "PID : $($process.Id)"
        Write-Host "起動時刻: $($process.StartTime)"
        Write-Host "稼働時間: $uptime"
        Write-ServerUrls
    } else {
        Write-Host "状態: 停止中 (古い PID ファイルを削除します)"
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        exit 1
    }
}

switch ($Command) {
    "start"   { Start-Server }
    "stop"    { Stop-Server }
    "restart" { Stop-Server; Start-Sleep -Milliseconds 500; Start-Server }
    "status"  { ServerStatus }
}
