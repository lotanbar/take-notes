$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $ProjectRoot
try {
  npm run stage:media-tools
  if ($LASTEXITCODE -ne 0) { throw "Media tool verification failed." }
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Tauri portable build failed." }
  $CargoMetadata = cargo metadata --format-version 1 --no-deps --manifest-path (Join-Path $ProjectRoot "src-tauri\Cargo.toml") | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not locate the Cargo target directory." }
  $Application = Join-Path $CargoMetadata.target_directory "release\vault-notes-app.exe"

  $OutputRoot = Join-Path $ProjectRoot "artifacts\portable"
  $PortableRoot = Join-Path $OutputRoot "vault-notes-app-portable"
  $ResolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
  $ResolvedPortableRoot = [System.IO.Path]::GetFullPath($PortableRoot)
  if (-not $ResolvedPortableRoot.StartsWith($ResolvedOutputRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable output escaped the intended artifact directory."
  }
  if (Test-Path -LiteralPath $PortableRoot) { Remove-Item -LiteralPath $PortableRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $PortableRoot "tools") | Out-Null
  Copy-Item -LiteralPath $Application -Destination $PortableRoot
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "src-tauri\tools\ffmpeg.exe") -Destination (Join-Path $PortableRoot "tools\ffmpeg.exe")
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "scripts\FFMPEG-NOTICE.txt") -Destination $PortableRoot

  $Zip = Join-Path $OutputRoot "vault-notes-app-0.5.2-windows-x64-portable.zip"
  if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
  Compress-Archive -LiteralPath $PortableRoot -DestinationPath $Zip -CompressionLevel Optimal
  Get-Item -LiteralPath $Zip | Select-Object FullName,Length
} finally {
  Pop-Location
}
