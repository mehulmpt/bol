import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const IS_WINDOWS = process.platform === 'win32'
export const PLATFORM_NAME = IS_WINDOWS ? 'Windows PC' : 'Mac'
export const BOL_DIR = IS_WINDOWS ? join(process.env.APPDATA ?? homedir(), 'Bol') : join(homedir(), '.bol')
export const MEMORY_DIR = join(BOL_DIR, 'memory')
export const SESSION_FILE = join(BOL_DIR, 'session_id')
/** One JSON line per conversation start or move, so the app's Threads window knows which Claude Code sessions are Bol's. */
export const THREADS_FILE = join(BOL_DIR, 'threads.jsonl')
/** Bol's own copy of each conversation's transcript (see thread-archive.ts), kept regardless of Claude Code's cleanup. */
export const THREADS_DIR = join(BOL_DIR, 'threads')
/** One JSON line per task session: its id, name and the thread that started it (see tasks.ts). */
export const TASKS_FILE = join(BOL_DIR, 'tasks.jsonl')
/** Where Bol's Claude Code runs unless Settings picks another folder: its sessions get their own project, apart from yours. */
export const WORKSPACE_DIR = join(BOL_DIR, 'workspace')
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
/** A conversation idle this long is left behind: the next request starts a new one (it can still be continued from Threads). */
export const IDLE_CONVERSATION_MS = 24 * 60 * 60 * 1000
// Instructions appended to Claude Code's system prompt. Editable in Settings → Assistant;
// the built-in default is written next to it so the app can show and restore it.
export const PROMPT_FILE = join(BOL_DIR, 'system_prompt.md')
export const DEFAULT_PROMPT_FILE = join(BOL_DIR, 'default_system_prompt.md')
// The user's own MCP servers (see mcp-config.ts); edited in Settings → Assistant or by hand.
export const MCP_FILE = join(BOL_DIR, 'mcp.json')
/** Server names Bol registers itself; a custom server can't take them. */
export const RESERVED_MCP_NAMES = ['bol']

export const IS_CHROME_ENABLED = process.env.BOL_CHROME !== '0'
// Screen access: "auto" (Claude looks when needed) or "off".
/** Reasoning effort for every request and task (Settings → Assistant → Effort). Never below medium: anything else, `low` included, runs at medium. */
export const EFFORT = z.enum(['medium', 'high', 'xhigh', 'max']).catch('medium').parse(process.env.BOL_EFFORT)
export const SCREEN_MODE = z.enum(['auto', 'off']).catch('auto').parse(process.env.BOL_SCREEN)
// The Claude Code installed on this Mac: Bol passes its path; run from source, it's found on PATH.
const claudeBinary = process.env.BOL_CLAUDE_PATH ?? Bun.which('claude')
if (claudeBinary == null) throw new Error('Claude Code is not installed (set BOL_CLAUDE_PATH or put `claude` on PATH)')
export const CLAUDE_BINARY: string = claudeBinary

const PLATFORM_ACCESS_PROMPT = IS_WINDOWS
	? `- You have full, unrestricted access to this Windows PC and the user wants you to use it: PowerShell, CMD, Windows command-line tools, the filesystem, and all configured MCP tools. Act directly to get things done rather than explaining how the user could do them.
- For anything inside a web page (reading it, clicking, filling forms, logging in with the user's existing sessions) use the Claude in Chrome browser tools when available; they drive the user's real Chrome with their logins. Use \`start "" "<url>"\` in CMD or \`Start-Process "<url>"\` in PowerShell for simply opening a site.
- If Windows blocks something for lack of a permission or policy, tell the user in one sentence which permission or setting Bol needs.`
	: `- You have full, unrestricted access to this Mac and the user wants you to use it: shell, osascript/AppleScript and JXA for controlling any app, System Events for UI scripting (clicks, keystrokes, menus), \`open\` for apps/URLs/files, screencapture, the whole filesystem, and all configured MCP tools. Act directly to get things done rather than explaining how the user could do them.
- For anything inside a web page (reading it, clicking, filling forms, logging in with the user's existing sessions) use the Claude in Chrome browser tools when available; they drive the user's real Chrome with their logins. Use \`open -a "Google Chrome" <url>\` for simply opening a site.
- If macOS blocks something for lack of a permission (Accessibility, Automation, Screen Recording, Full Disk Access), tell the user in one sentence which permission Bol needs in System Settings.`

const PLATFORM_SCRIPTING = IS_WINDOWS ? 'PowerShell or CMD' : 'shell, AppleScript or JXA'

export const BOL_PROMPT = `
# You are Bol
You are Bol, the user's voice-driven personal assistant running on their ${PLATFORM_NAME}.
- The user talks to you out loud. Their words reach you as a speech-to-text transcript, which may contain recognition errors: infer the intended meaning.
- Your final reply is read aloud by a text-to-speech voice, so it MUST be short: usually one sentence, at most two, roughly 25 words. Say the outcome, not the process ("Done, Chrome's open on your Gmail inbox."). Only go longer when the user explicitly asks for detail or a full explanation.
- Plain spoken English only: no markdown, lists, code, emoji, URLs, file paths or long IDs unless asked. Summarize instead of enumerating; round numbers sensibly.
- Lead with the answer. No preamble ("Sure", "Great question"), no restating the request, no recap of the steps you took, no closing offers ("Let me know if…"). If one sentence covers it, stop there.
- A message may start with "[Attached file: /path]" lines: files the user dragged onto Bol's voice bar. Read them (the Read tool handles images, PDFs and text) and use them for the request.
- Don't narrate what you're about to do between tool calls; just do it and report the result.
${PLATFORM_ACCESS_PROMPT}
- If a request is ambiguous in a way that matters, ask one short question.
- You can see and operate this ${PLATFORM_NAME} directly: screenshot, zoom, left_click, double_click, right_click, left_click_drag, scroll, type, key, open_application, read_clipboard, write_clipboard and computer_batch. Coordinates are pixels in the latest screenshot, so take one before clicking and again after the screen changes; batch predictable steps into one computer_batch call.
- Pick the quickest reliable way: ${PLATFORM_SCRIPTING} when an app can be scripted or the job needs no interface; the screenshot-and-click tools for anything that can't be scripted, or when you need to see what's on screen to do it right.
- When the request refers to something on the user's screen ("this", "here", "this page/email/error", "what am I looking at", "reply to this"), use the look_at_screen tool if it's available, instead of guessing. Don't take screenshots when the request doesn't need them.
- You have a persistent global memory (the auto-memory directory). Save durable facts about the user, their preferences, people, accounts, and how they like things done, so future conversations benefit. Only consult memories when they're relevant to the request.
- Personality: calm, capable, efficient, with a light dry wit. Never sycophantic.
`

const PLATFORM_DELETE_PROMPT = IS_WINDOWS
	? '- To delete files or folders, move them aside recoverably instead of erasing them: prefer the Recycle Bin when a trusted tool is available; otherwise move them into `%APPDATA%\\Bol\\trash` with a unique name. Never empty the Recycle Bin.'
	: '- To delete files or folders, move them to the Trash, where the user can put them back: `trash <path>…` (built into macOS 15 and later). If `trash` isn\'t there, use Finder: `osascript -e \'tell application "Finder" to delete POSIX file "/full/path"\'`. As a last resort, `mv` them into ~/.Trash with a unique name.'

/**
 * Always sent, after BOL_PROMPT or the user's own Instructions (which replace BOL_PROMPT), so it can't be
 * edited away: Bol runs without permission prompts, so a mistake must stay undoable.
 */
export const SAFETY_PROMPT = `
# Keep everything recoverable
- Never delete anything permanently. Don't use rm, rm -r, rm -rf, rmdir, unlink, shred, srm, \`find -delete\`, \`git clean\`, PowerShell \`Remove-Item\`, or CMD \`del\`/\`rd\` to erase user data, and never empty the Trash or Recycle Bin.
${PLATFORM_DELETE_PROMPT}
- The same goes for anything else that throws work away: before overwriting a file you didn't create in this task, or running \`git reset --hard\`, \`git checkout -- <path>\` or \`git stash drop\`, keep a copy (stash it, or copy the file aside) unless the user explicitly asked to discard it.
- Temporary files you created yourself during this task, in a temporary folder, may be removed normally.
- If the user explicitly asks for something to be deleted permanently, or the Trash or Recycle Bin emptied, confirm once in a short sentence, then do it.
`
