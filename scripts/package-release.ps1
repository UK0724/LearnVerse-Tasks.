$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
npm run build:lambda
if ($LASTEXITCODE -ne 0) { throw 'Lambda build failed' }
New-Item -ItemType Directory -Path output -Force | Out-Null
Compress-Archive -Path output/lambda/* -DestinationPath output/api.zip -Force
$taskHash = (Get-FileHash -LiteralPath output/api.zip -Algorithm SHA256).Hash.ToLowerInvariant()
$taskSourceFiles = [ordered]@{}
Get-ChildItem -Path server,client,shared,infra,scripts -Recurse -File | Where-Object { $_.Extension -in '.ts','.tsx','.css','.html','.json','.mjs','.py','.ps1','.png','.svg' } | Sort-Object FullName | ForEach-Object {
  $taskRelative = [IO.Path]::GetRelativePath((Get-Location).Path, $_.FullName).Replace('\','/')
  $taskSourceFiles[$taskRelative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskManifest = [ordered]@{
  apiSha256 = $taskHash
  apiKey = "api/$taskHash.zip"
  builtAt = [DateTime]::UtcNow.ToString('o')
  lockSha256 = (Get-FileHash -LiteralPath package-lock.json -Algorithm SHA256).Hash.ToLowerInvariant()
  sourceFiles = $taskSourceFiles
}
$taskManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath output/release.json -Encoding utf8NoBOM
Compress-Archive -Path dist,infra,scripts,output/api.zip,output/release.json -DestinationPath output/aws-release.zip -Force
Write-Output "Release: output/aws-release.zip; API SHA256: $taskHash"
