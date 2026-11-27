#!/usr/bin/env bash
# Cross-builds Bol for Windows. NSIS packaging works best on Windows; on Linux this still validates
# the shell and produces the Windows brain executable before invoking electron-builder.
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Installing brain dependencies"
bun install --frozen-lockfile --silent

echo "→ Type-checking and compiling bol-brain.exe"
bun check src/typescript/index.ts
mkdir -p build/windows/brain
bun build src/typescript/index.ts --compile --minify --target=bun-windows-x64 --outfile build/windows/brain/bol-brain.exe >/dev/null

echo "→ Installing Windows shell dependencies"
cd windows
bun install --frozen-lockfile --silent

if [[ " $* " == *" --skip-installer "* ]]; then
	echo "✓ Done: build/windows/brain/bol-brain.exe"
else
	echo "→ Packaging Bol for Windows"
	bunx electron-builder --win --x64 --config electron-builder.yml
	echo "✓ Done: build/windows/installer"
fi
