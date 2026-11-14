param(
    [switch]$Rebuild,
    [switch]$NoBrowser,
    [ValidateRange(1, 65535)][int]$ApiPort = 8000,
    [ValidateRange(1, 65535)][int]$WebPort = 3000
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$services = @()
$apiUrl = "http://127.0.0.1:$ApiPort"
$webUrl = "http://localhost:$WebPort"
$logDir = Join-Path $root '.logs'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Komut basarisiz oldu (cikis kodu $LASTEXITCODE): $Program"
    }
}

function Test-Http {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-Service {
    param([System.Diagnostics.Process]$Process, [string]$Url, [string]$Name)
    $deadline = (Get-Date).AddMinutes(5)
    do {
        if ($Process.HasExited) {
            throw "$Name durdu. Ayrintilar: $logDir"
        }
        if (Test-Http $Url) { return }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "$Name zamaninda baslatilamadi. Ayrintilar: $logDir"
}

try {
    $Host.UI.RawUI.WindowTitle = 'FireRosetta'
    if ($ApiPort -eq $WebPort) { throw 'API ve web portlari farkli olmali.' }

    # A second click opens the running app instead of starting duplicate servers.
    $alreadyRunning = $false
    try {
        $schema = Invoke-RestMethod -Uri "$apiUrl/openapi.json" -TimeoutSec 3
        $alreadyRunning = $schema.info.title -like 'FireRosetta*'
    } catch {}
    if ($alreadyRunning -and (Test-Http "$webUrl/api/meta")) {
        if ($Rebuild) { throw 'Veriyi yenilemeden once calisan FireRosetta penceresini kapatin.' }
        if (-not $NoBrowser) { Start-Process $webUrl }
        return
    }

    foreach ($port in @($ApiPort, $WebPort)) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try { $listener.Start() }
        catch { throw "$port portu kullanimda. Bu portu kullanan programi kapatin." }
        finally { $listener.Stop() }
    }

    $uv = Join-Path $root '.runtime\uv\uv.exe'
    if (-not (Test-Path -LiteralPath $uv)) {
        $uv = (Get-Command uv.exe -ErrorAction Stop).Source
    }
    $node = Join-Path $root '.runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $node)) {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $npm = Join-Path $root '.runtime\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npm)) {
        $npm = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
    }
    if (-not (Test-Path -LiteralPath $npm)) { throw 'npm bulunamadi. Node.js ve npm kurulumunu kontrol edin.' }
    $env:PATH = "$(Split-Path $node);$env:PATH"
    $env:UV_CACHE_DIR = Join-Path $root '.runtime\uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $root '.runtime\python'
    $env:npm_config_cache = Join-Path $root '.runtime\npm-cache'
    $env:FIREROSETTA_API_URL = $apiUrl
    $env:PYTHONUNBUFFERED = '1'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    Push-Location (Join-Path $root 'backend')
    try {
        Write-Host '==> Python bagimliliklari kontrol ediliyor...'
        Invoke-Checked $uv @('sync', '--frozen')
        $requiredData = @('processed\harmonized.parquet', 'processed\cells.parquet', 'processed\metrics.json', 'staged\hotspots.parquet')
        $dataRoot = if ($env:FIREROSETTA_DATA) { $env:FIREROSETTA_DATA } else { Join-Path $root 'data' }
        $missingData = @($requiredData | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dataRoot $_)) })
        if ($Rebuild -or $missingData.Count -gt 0) {
            Write-Host '==> Ilk veri hazirligi zaman alabilir: fetch -> ingest -> grid -> harmonize'
            $fetchArgs = @('run', '--frozen', 'python', '-m', 'firerosetta.fetch')
            if ($Rebuild) { $fetchArgs += '--force' }
            Invoke-Checked $uv $fetchArgs
            foreach ($step in @('ingest', 'grid', 'harmonize')) {
                Write-Host "==> firerosetta.$step"
                Invoke-Checked $uv @('run', '--frozen', 'python', '-m', "firerosetta.$step")
            }
        }
    } finally { Pop-Location }

    Push-Location (Join-Path $root 'web')
    try {
        if (-not (Test-Path -LiteralPath 'node_modules\next\package.json')) {
            Write-Host '==> Web bagimliliklari kuruluyor...'
            Invoke-Checked $node @($npm, 'ci')
        }
        if (-not (Test-Path -LiteralPath 'public\maplibre\maplibre-gl-worker.mjs')) {
            Invoke-Checked $node @($npm, 'run', 'postinstall')
        }
    } finally { Pop-Location }

    Write-Host "==> API baslatiliyor: $apiUrl"
    $api = Start-Process -FilePath $uv -ArgumentList @('run', '--frozen', 'uvicorn', 'firerosetta.api:app', '--host', '127.0.0.1', '--port', "$ApiPort") -WorkingDirectory (Join-Path $root 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'api.log') -RedirectStandardError (Join-Path $logDir 'api-error.log')
    $services += $api
    Wait-Service $api "$apiUrl/meta" 'API'

    Write-Host "==> Web baslatiliyor: $webUrl"
    $web = Start-Process -FilePath $node -ArgumentList @('node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', "$WebPort") -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'web.log') -RedirectStandardError (Join-Path $logDir 'web-error.log')
    $services += $web
    Wait-Service $web "$webUrl/api/meta" 'Web'
    Wait-Service $web $webUrl 'Web arayuzu'

    if (-not $NoBrowser) { Start-Process $webUrl }
    Write-Host "==> FireRosetta hazir: $webUrl"
    Write-Host 'Kapatmak icin bu pencerede Ctrl+C tuslarina basin.'
    while ($true) {
        foreach ($service in $services) {
            if ($service.HasExited) { throw "Bir servis durdu. Ayrintilar: $logDir" }
        }
        Start-Sleep -Seconds 1
    }
} catch {
    Write-Host "Hata: $($_.Exception.Message)" -ForegroundColor Red
    if (-not $NoBrowser) { Read-Host 'Pencereyi kapatmak icin Enter tusuna basin' | Out-Null }
    exit 1
} finally {
    foreach ($service in $services) {
        if (-not $service.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $service.Id /T /F 2>$null | Out-Null
        }
    }
}
