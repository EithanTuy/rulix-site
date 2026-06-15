param(
  [Parameter(Mandatory = $true)]
  [string]$Entry
)

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Location).Path
$outFile = Join-Path $repoRoot (".rulix-live-test-{0}.mjs" -f ([Guid]::NewGuid().ToString("N")))
$marker = Join-Path $repoRoot (".rulix-live-test-{0}.ok" -f ([Guid]::NewGuid().ToString("N")))

try {
  npx esbuild $Entry --bundle --platform=node --format=esm "--outfile=$outFile" --packages=external
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $env:RULIX_LIVE_SUCCESS_MARKER = $marker
  node $outFile
  $nodeExit = $LASTEXITCODE
  if (Test-Path -LiteralPath $marker) {
    $successFile = if ($env:RULIX_LIVE_WRAPPER_SUCCESS_FILE) {
      $env:RULIX_LIVE_WRAPPER_SUCCESS_FILE
    } else {
      Join-Path $repoRoot ".rulix-live-test-success.ok"
    }
    Set-Content -LiteralPath $successFile -Value "ok"
    exit 0
  }
  exit $nodeExit
}
finally {
  Remove-Item Env:\RULIX_LIVE_SUCCESS_MARKER -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
