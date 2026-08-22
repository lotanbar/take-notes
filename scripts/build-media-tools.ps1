$ErrorActionPreference = "Stop"
$MsysRoot = Join-Path $env:USERPROFILE "scoop\apps\msys2\current"
$Bash = Join-Path $MsysRoot "usr\bin\bash.exe"
if (-not (Test-Path -LiteralPath $Bash)) {
  throw "MSYS2 is required to build the lite FFmpeg executable."
}
$Script = Join-Path $PSScriptRoot "build-ffmpeg-lite.sh"
$Destination = Join-Path $PSScriptRoot "..\src-tauri\tools\ffmpeg.exe"
function Convert-ToMsysPath([string]$Path) {
  $Full = [System.IO.Path]::GetFullPath($Path).Replace("\", "/")
  if ($Full -notmatch "^([A-Za-z]):/(.*)$") { throw "Unsupported build path: $Full" }
  return "/$($Matches[1].ToLowerInvariant())/$($Matches[2])"
}
$UnixScript = Convert-ToMsysPath $Script
$UnixDestination = Convert-ToMsysPath $Destination
& $Bash -lc "export PATH=/ucrt64/bin:`$PATH; '$UnixScript' '$UnixDestination'"
if ($LASTEXITCODE -ne 0) { throw "Lite FFmpeg build failed with exit code $LASTEXITCODE." }
& (Join-Path $PSScriptRoot "stage-media-tools.ps1")
