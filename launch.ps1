$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = $null
$trellis = @('D:\AI\TRELLIS', 'C:\AI\TRELLIS', (Join-Path $root 'TRELLIS'))
$customPathFile = Join-Path $root 'trellis-path.txt'
if (Test-Path $customPathFile) {
    $custom = (Get-Content -Raw -Encoding UTF8 $customPathFile).Trim().Trim('\"')
    if ($custom) { $trellis = @($custom) + $trellis }
}
$configPath = Join-Path $env:LOCALAPPDATA 'TRELLIS-Atelier\settings.json'
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
        if ($cfg.trellis_path) { $trellis = @([string]$cfg.trellis_path) + $trellis }
    } catch { }
}
foreach ($folder in $trellis) {
    foreach ($venv in @('venv','\.venv')) {
        $candidate = Join-Path $folder ('code\' + $venv.TrimStart('\') + '\Scripts\pythonw.exe')
        if (Test-Path $candidate) { $python = $candidate; break }
    }
    if ($python) { break }
}
if (-not $python) {
    $existing = Join-Path $root '.venv\Scripts\pythonw.exe'
    if (Test-Path $existing) { $python = $existing }
}
if (-not $python) {
    try {
        $exe = (& py -3.11 -c 'import sys;print(sys.executable)' 2>$null | Select-Object -First 1).Trim()
        if ($exe -and (Test-Path $exe)) { $python = $exe -replace 'python.exe$','pythonw.exe' }
    } catch { }
}
if (-not $python -or -not (Test-Path $python)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Не найден Python 3.11 или окружение установленного TRELLIS. Сначала установите TRELLIS и укажите путь в локальных настройках.','Средство 3D') | Out-Null
    exit 1
}
Start-Process -FilePath $python -ArgumentList ('"' + (Join-Path $root 'desktop.py') + '"') -WorkingDirectory $root
