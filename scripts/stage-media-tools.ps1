$ErrorActionPreference = "Stop"
$ExpectedVersion = "8.1.2"
$MaximumBytes = 40MB
$Destination = Join-Path $PSScriptRoot "..\src-tauri\tools\ffmpeg.exe"

if (-not (Test-Path -LiteralPath $Destination)) {
  throw "The lite offline media tool is missing. Run npm run build:media-tools first."
}
$Item = Get-Item -LiteralPath $Destination
if ($Item.Length -gt $MaximumBytes) {
  throw "Refusing to bundle the oversized FFmpeg executable ($($Item.Length) bytes). Run npm run build:media-tools."
}
$Version = (& $Item.FullName -version | Select-Object -First 1)
if ($Version -notmatch [regex]::Escape($ExpectedVersion)) {
  throw "Expected pinned FFmpeg $ExpectedVersion, found: $Version"
}
$Encoders = (& $Item.FullName -hide_banner -encoders 2>&1) -join "`n"
if ($Encoders -notmatch "libaom-av1" -or $Encoders -notmatch "libopus") {
  throw "Lite FFmpeg is missing the required AV1 or Opus encoder."
}
$Decoders = (& $Item.FullName -hide_banner -decoders 2>&1) -join "`n"
if ($Decoders -notmatch "libaom-av1") {
  throw "Lite FFmpeg is missing the portable software AV1 decoder."
}
Write-Host "Staged lite FFmpeg: $($Item.Length) bytes"
