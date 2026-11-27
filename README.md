# Bol

**Talk to your Mac. Claude does the work.** Press ⌘J, say what you need, and Claude Code does it on your
Mac, then tells you when it's done. Runs on your Claude subscription. [agentbol.com](https://agentbol.com)

## Install

1. Install [Claude Code](https://claude.com/claude-code) and sign in with Claude Pro or Max.
2. [Download Bol](https://agentbol.com/download), drag it to Applications, open it. Setup takes two minutes.
3. Press **⌘J** anywhere and talk.

macOS 13+, Apple silicon or Intel. Signed, notarized, and it updates itself when it's idle.

## Windows

A Windows port lives in `windows/`: an Electron tray app and voice bar driving the same Claude brain. It uses
**Ctrl+J**, Windows speech synthesis, OpenAI speech recognition, screen capture, keyboard/pointer control, and the
same JSON-lines brain protocol as the Mac app.

Build it on Windows with Bun and PowerShell:

```powershell
.\build-windows.ps1          # NSIS installer and portable exe in build\windows\installer
.\build-windows.ps1 -SkipInstaller  # only compile build\windows\brain\bol-brain.exe
```

The `Windows build` workflow produces the installer as a build artifact on Windows runners.

The Windows port is newer than the Mac app. It does not yet include the full onboarding flow, Threads window,
system-wide dictation, MCP settings UI or automatic updates. Voice input needs an OpenAI API key in Settings;
Claude itself still uses the signed-in Claude Code subscription. Builds are unsigned unless electron-builder is
configured with a Windows code-signing certificate.

> [!WARNING]
> Bol runs Claude Code with **permission checks off**: it acts on your computer without asking first.

> [!NOTE]
> Listening and plan usage use Anthropic endpoints that aren't public APIs (the ones behind Claude Code's
> `/voice` and `/usage`). If they break, Bol says so and can listen with OpenAI instead. Not affiliated
> with Anthropic.

## What it does

- **Talk:** ⌘J, speak, Enter to send, Esc to stop. Replies are spoken (macOS, OpenAI or Noiz AI voices).
- **Work:** every Claude Code tool, MCP servers, Claude in Chrome, and its own computer use.
- **Models:** Claude Opus 5.5 or Fable 5.2 only, never below medium effort.
- **Tasks:** long jobs run in the background; Bol comes back when they're done.
- **Dictation:** hold fn in any app, speak, let go to paste. Optional.
- **Threads and memory:** every conversation and step, kept in `~/.bol`.

## Develop

```sh
./build.sh --install --run   # build, copy to /Applications, launch
./test.sh                    # type check, formatting, Swift tests
```

Needs Bun and the Swift command-line tools. For permissions that survive rebuilds, create a code-signing
certificate named "Bol Local Signing" in Keychain Access (or set `BOL_LOCAL_IDENTITY`).

```
src/swift/        the menu-bar app (app, audio, speech-to-text, text-to-speech, hud, dictation, threads, settings…)
src/typescript/   the brain: Claude Agent SDK, compiled to one executable
tests/swift/      Swift Testing suites
website/          agentbol.com and the update feed (latest.json), a Cloudflare Worker
assets/           app icon, entitlements, DMG window design
```

Speech-to-text and voice providers are plugins: one file each under `providers/`.

## Release

```sh
export BOL_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAM ID>)"
./release.sh 0.2.0 5 "What's new."
```

Builds a universal app, signs and notarizes it and its DMG, uploads to R2 (`dl.agentbol.com`), and updates
the feed and `/download`. The build number must go up each time. One-time setup is at the top of the script.

## Contributing

Pull requests welcome. Run `./test.sh` first; commits use [Conventional Commits](https://www.conventionalcommits.org).

## License

[MIT](LICENSE). Claude is a trademark of Anthropic.
