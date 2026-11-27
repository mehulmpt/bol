# Builds Bol for Windows: the Bun brain executable plus the Electron installer and portable app.
# Run in PowerShell from the repository root: .\build-windows.ps1
param(
	[switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path "$PSScriptRoot"
Push-Location $Root
try {
	Write-Host '→ Installing brain dependencies'
	bun install --frozen-lockfile --silent

	Write-Host '→ Type-checking and compiling bol-brain.exe'
	bun check src/typescript/index.ts
	New-Item -ItemType Directory -Force -Path build/windows/brain | Out-Null
	bun build src/typescript/index.ts --compile --minify --target=bun-windows-x64 --outfile build/windows/brain/bol-brain.exe

	Push-Location windows
	try {
		Write-Host '→ Installing Windows shell dependencies'
		bun install --frozen-lockfile --silent
		if ($SkipInstaller) {
			Write-Host '✓ Done: build/windows/brain/bol-brain.exe'
		} else {
			Write-Host '→ Packaging Bol for Windows'
			bunx electron-builder --win --x64 --config electron-builder.yml
			Write-Host '✓ Done: build/windows/installer'
		}
	} finally {
		Pop-Location
	}
} finally {
	Pop-Location
}
