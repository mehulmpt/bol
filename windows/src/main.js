import {
	app,
	BrowserWindow,
	clipboard,
	desktopCapturer,
	globalShortcut,
	ipcMain,
	Menu,
	nativeImage,
	screen,
	shell,
	Tray,
} from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'
const isPackaged = app.isPackaged
const bolDir = path.join(app.getPath('appData'), 'Bol')
const configFile = path.join(bolDir, 'windows-config.json')
const brainPath = isPackaged
	? path.join(process.resourcesPath, 'brain', 'bol-brain.exe')
	: path.resolve(dirname, '../../build/windows/brain/bol-brain.exe')
const iconPath = path.resolve(dirname, '../assets/icon.png')

const defaultConfig = {
	openaiApiKey: '',
	hotkey: 'Control+J',
	model: 'claude-opus-5-5',
	effort: 'medium',
	workingDirectory: '',
	isChromeEnabled: true,
	screenAccess: 'auto',
	isSilentMode: false,
	speakReplies: true,
	voice: '',
}

let config = { ...defaultConfig }
let voiceWindow = null
let tray = null
let brain = null
let isQuitting = false
let selectedDisplay = 'auto'
let lastCapture = null

async function loadConfig() {
	try {
		config = { ...defaultConfig, ...JSON.parse(await fs.readFile(configFile, 'utf8')) }
	} catch {}
	await fs.mkdir(bolDir, { recursive: true }).catch(() => {})
}

async function saveConfig() {
	await fs.mkdir(bolDir, { recursive: true })
	await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
}

function sendToWindow(type, data = {}) {
	if (voiceWindow == null || voiceWindow.isDestroyed()) return
	voiceWindow.webContents.send('bol-event', { type, ...data })
}

function createVoiceWindow() {
	voiceWindow = new BrowserWindow({
		width: 760,
		height: 230,
		frame: false,
		transparent: true,
		resizable: false,
		show: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		fullscreenable: false,
		maximizable: false,
		webPreferences: {
			preload: path.join(dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	})
	voiceWindow.loadFile(path.join(dirname, 'renderer/index.html'))
	voiceWindow.on('blur', () => {
		if (!voiceWindow.webContents.isDevToolsOpened()) hideVoiceWindow()
	})
	voiceWindow.on('closed', () => {
		voiceWindow = null
	})
}

function positionVoiceWindow() {
	if (voiceWindow == null) return
	const point = screen.getCursorScreenPoint()
	const display = screen.getDisplayNearestPoint(point)
	const area = display.workArea
	const bounds = voiceWindow.getBounds()
	voiceWindow.setPosition(
		Math.round(area.x + (area.width - bounds.width) / 2),
		Math.round(area.y + area.height - bounds.height - 56),
	)
}

function showVoiceWindow() {
	if (voiceWindow == null) createVoiceWindow()
	positionVoiceWindow()
	voiceWindow.showInactive()
	voiceWindow.focus()
	sendToWindow('shown')
}

function hideVoiceWindow() {
	if (voiceWindow == null || !voiceWindow.isVisible()) return
	sendToWindow('hidden')
	voiceWindow.hide()
}

function toggleVoiceWindow() {
	if (voiceWindow != null && voiceWindow.isVisible()) hideVoiceWindow()
	else showVoiceWindow()
}

function registerHotkey() {
	globalShortcut.unregisterAll()
	try {
		if (!globalShortcut.register(config.hotkey || defaultConfig.hotkey, toggleVoiceWindow))
			throw new Error('hotkey unavailable')
	} catch (error) {
		config.hotkey = defaultConfig.hotkey
		globalShortcut.register(defaultConfig.hotkey, toggleVoiceWindow)
		sendToWindow('error', {
			message: `${config.hotkey} could not be registered; restored ${defaultConfig.hotkey}.`,
		})
	}
}

function trayImage() {
	const image = nativeImage.createFromPath(iconPath)
	return image.isEmpty() ? nativeImage.createEmpty() : image
}

function createTray() {
	tray = new Tray(trayImage())
	tray.setToolTip('Bol — Ctrl+J to talk')
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: 'Talk to Bol (Ctrl+J)', click: showVoiceWindow },
			{
				label: 'Settings',
				click: () => {
					showVoiceWindow()
					sendToWindow('open-settings')
				},
			},
			{ type: 'separator' },
			{
				label: 'Quit Bol',
				click: () => {
					isQuitting = true
					app.quit()
				},
			},
		]),
	)
	tray.on('click', toggleVoiceWindow)
}

function brainEnvironment() {
	const env = { ...process.env }
	env.BOL_CWD = config.workingDirectory || path.join(bolDir, 'workspace')
	env.BOL_MODEL = config.model
	env.BOL_EFFORT = config.effort
	env.BOL_CHROME = config.isChromeEnabled ? '1' : '0'
	env.BOL_SCREEN = config.screenAccess
	delete env.ANTHROPIC_API_KEY
	return env
}

class BrainBridge {
	constructor() {
		this.process = null
		this.buffer = ''
		this.restartTimer = null
		this.failures = 0
	}

	start() {
		if (this.process != null) return
		if (!isWindows) {
			sendToWindow('brain-status', { status: 'error', message: 'This shell is intended for Windows.' })
			return
		}
		if (!existsSync(brainPath)) {
			sendToWindow('brain-status', {
				status: 'error',
				message: `Bol brain is missing at ${brainPath}. Run build-windows.ps1.`,
			})
			return
		}
		this.process = spawn(brainPath, [], {
			cwd: path.dirname(brainPath),
			env: brainEnvironment(),
			windowsHide: true,
		})
		this.process.stdout.setEncoding('utf8')
		this.process.stdout.on('data', (chunk) => this.consume(chunk))
		this.process.stderr.setEncoding('utf8')
		this.process.stderr.on('data', (chunk) => console.error('bol brain:', chunk.trim()))
		this.process.on('error', (error) => {
			sendToWindow('brain-status', { status: 'error', message: `Bol brain failed to start: ${error.message}` })
		})
		this.process.on('exit', (code) => {
			this.process = null
			if (!isQuitting) {
				this.failures += 1
				if (this.failures >= 5) {
					sendToWindow('brain-status', {
						status: 'error',
						message: 'Bol brain keeps stopping. Check that Claude Code is installed and signed in.',
					})
					return
				}
				sendToWindow('brain-status', {
					status: 'restarting',
					message: `Brain stopped (${code ?? 'unknown'}); restarting.`,
				})
				this.restartTimer = setTimeout(() => this.start(), 1000)
			}
		})
	}

	restart() {
		this.failures = 0
		this.stop()
		this.start()
	}

	stop() {
		if (this.restartTimer != null) clearTimeout(this.restartTimer)
		this.restartTimer = null
		if (this.process == null) return
		const processRef = this.process
		this.process = null
		processRef.removeAllListeners('exit')
		try {
			processRef.stdin.end()
		} catch {}
		processRef.kill()
	}

	send(command) {
		if (this.process == null) this.start()
		if (this.process?.stdin.writable) this.process.stdin.write(`${JSON.stringify(command)}\n`)
	}

	consume(chunk) {
		this.buffer += chunk
		for (;;) {
			const newline = this.buffer.indexOf('\n')
			if (newline < 0) return
			const line = this.buffer.slice(0, newline).trim()
			this.buffer = this.buffer.slice(newline + 1)
			if (line !== '') this.handleLine(line)
		}
	}

	handleLine(line) {
		let event
		try {
			event = JSON.parse(line)
		} catch {
			return
		}
		if (event.type === 'control') {
			void performControl(event.id, event.action)
			return
		}
		if (event.type === 'ready') {
			this.failures = 0
			sendToWindow('brain-status', { status: 'ready' })
		}
		sendToWindow('brain-event', { event })
	}
}

function psEscape(text) {
	return String(text).replaceAll("'", "''")
}

function utf8Base64(text) {
	return Buffer.from(String(text), 'utf8').toString('base64')
}

function runPowerShell(script) {
	return new Promise((resolve, reject) => {
		const encoded = Buffer.from(script, 'utf16le').toString('base64')
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
			{ windowsHide: true, timeout: 15000 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(stderr?.trim() || error.message))
				else resolve(String(stdout).trim())
			},
		)
	})
}

const inputPrelude = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BolInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void LeftDown() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void LeftUp() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
  public static void RightDown() { mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); }
  public static void RightUp() { mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
  public static void MiddleDown() { mouse_event(0x0020, 0, 0, 0, UIntPtr.Zero); }
  public static void MiddleUp() { mouse_event(0x0040, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(0x0800, 0, 0, unchecked((uint)delta), UIntPtr.Zero); }
  public static void HWheel(int delta) { mouse_event(0x01000, 0, 0, unchecked((uint)delta), UIntPtr.Zero); }
  public static void KeyDown(int key) { keybd_event((byte)key, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(int key) { keybd_event((byte)key, 0, 2, UIntPtr.Zero); }
  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }
}
"@
`

function coordinateToScreen(coordinate) {
	const point = Array.isArray(coordinate) ? coordinate : [0, 0]
	if (lastCapture == null) return { x: Math.round(point[0] ?? 0), y: Math.round(point[1] ?? 0) }
	const { bounds, width, height } = lastCapture
	return {
		x: Math.round(bounds.x + ((point[0] ?? 0) / width) * bounds.width),
		y: Math.round(bounds.y + ((point[1] ?? 0) / height) * bounds.height),
	}
}

const keyCodes = {
	control: 0x11,
	ctrl: 0x11,
	shift: 0x10,
	alt: 0x12,
	option: 0x12,
	cmd: 0x5b,
	meta: 0x5b,
	win: 0x5b,
	return: 0x0d,
	enter: 0x0d,
	escape: 0x1b,
	esc: 0x1b,
	tab: 0x09,
	space: 0x20,
	backspace: 0x08,
	delete: 0x2e,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	pagedown: 0x22,
	up: 0x26,
	down: 0x28,
	left: 0x25,
	right: 0x27,
}

function keyCode(name) {
	const normalized = String(name).trim().toLowerCase()
	if (keyCodes[normalized] != null) return keyCodes[normalized]
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(normalized)) return 0x6f + Number(normalized.slice(1))
	if (/^[a-z0-9]$/.test(normalized)) return normalized.toUpperCase().charCodeAt(0)
	return null
}

function keyPressScript(text, { repeat = 1, holdSeconds = 0 } = {}) {
	const parts = String(text)
		.split('+')
		.map((part) => part.trim())
		.filter(Boolean)
	const modifiers = []
	const keys = []
	for (const part of parts) {
		const code = keyCode(part)
		if (code == null) continue
		if ([0x10, 0x11, 0x12, 0x5b].includes(code) && keys.length === 0) modifiers.push(code)
		else keys.push(code)
	}
	if (keys.length === 0 && modifiers.length > 0) keys.push(modifiers.pop())
	if (keys.length === 0) return ''
	const downModifiers = modifiers.map((code) => `[BolInput]::KeyDown(${code})`).join('\n')
	const upModifiers = [...modifiers]
		.reverse()
		.map((code) => `[BolInput]::KeyUp(${code})`)
		.join('\n')
	if (holdSeconds > 0) {
		const downs = [...modifiers, ...keys].map((code) => `[BolInput]::KeyDown(${code})`).join('\n')
		const ups = [...modifiers, ...keys]
			.reverse()
			.map((code) => `[BolInput]::KeyUp(${code})`)
			.join('\n')
		return `${inputPrelude}\n${downs}\nStart-Sleep -Milliseconds ${Math.round(holdSeconds * 1000)}\n${ups}`
	}
	const presses = Array.from({ length: Math.max(1, repeat) }, () =>
		keys
			.map((code) => `[BolInput]::KeyDown(${code})\nStart-Sleep -Milliseconds 20\n[BolInput]::KeyUp(${code})`)
			.join('\n'),
	).join('\nStart-Sleep -Milliseconds 30\n')
	return `${inputPrelude}\n${downModifiers}\n${presses}\n${upModifiers}`
}

async function pressKeys(text, options = {}) {
	const script = keyPressScript(text, options)
	if (script === '') throw new Error(`Unsupported key combination: ${text}`)
	await runPowerShell(script)
}

async function clickMouse(action) {
	const point = coordinateToScreen(action.coordinate)
	const button = action.name.startsWith('right') ? 'Right' : action.name.startsWith('middle') ? 'Middle' : 'Left'
	const clicks = action.name.startsWith('triple') ? 3 : action.name.startsWith('double') ? 2 : 1
	const press = `[BolInput]::${button}Down()\nStart-Sleep -Milliseconds 25\n[BolInput]::${button}Up()`
	const script = `${inputPrelude}\n[BolInput]::Move(${point.x}, ${point.y})\n${Array.from({ length: clicks }, () => press).join('\nStart-Sleep -Milliseconds 70\n')}`
	await runPowerShell(script)
}

async function performMouseAction(action) {
	switch (action.name) {
		case 'left_click':
		case 'right_click':
		case 'middle_click':
		case 'double_click':
		case 'triple_click':
			await clickMouse(action)
			return 'Clicked.'
		case 'mouse_move': {
			const point = coordinateToScreen(action.coordinate)
			await runPowerShell(`${inputPrelude}\n[BolInput]::Move(${point.x}, ${point.y})`)
			return 'Pointer moved.'
		}
		case 'left_mouse_down':
			await runPowerShell(`${inputPrelude}\n[BolInput]::LeftDown()`)
			return 'Left button held.'
		case 'left_mouse_up':
			await runPowerShell(`${inputPrelude}\n[BolInput]::LeftUp()`)
			return 'Left button released.'
		case 'left_click_drag': {
			const end = coordinateToScreen(action.coordinate)
			const start = action.startCoordinate == null ? null : coordinateToScreen(action.startCoordinate)
			const moveStart = start == null ? '' : `[BolInput]::Move(${start.x}, ${start.y})\n`
			const script = `${inputPrelude}\n${moveStart}[BolInput]::LeftDown()\nStart-Sleep -Milliseconds 120\n[BolInput]::Move(${end.x}, ${end.y})\nStart-Sleep -Milliseconds 120\n[BolInput]::LeftUp()`
			await runPowerShell(script)
			return 'Dragged.'
		}
		case 'scroll': {
			const point = coordinateToScreen(action.coordinate)
			const amount = Math.max(1, Number(action.scrollAmount ?? 3))
			const direction = action.scrollDirection ?? 'down'
			const vertical = direction === 'up' || direction === 'down'
			const sign = direction === 'up' || direction === 'left' ? 1 : -1
			const delta = sign * 120 * amount
			const method = vertical ? 'Wheel' : 'HWheel'
			await runPowerShell(
				`${inputPrelude}\n[BolInput]::Move(${point.x}, ${point.y})\n[BolInput]::${method}(${delta})`,
			)
			return 'Scrolled.'
		}
		default:
			throw new Error(`Unsupported mouse action ${action.name}`)
	}
}

function displayChoices() {
	return screen
		.getAllDisplays()
		.map((display) => ({
			id: String(display.id),
			label: display.label || `Display ${display.id}`,
			bounds: display.bounds,
		}))
}

function pickDisplay() {
	const displays = screen.getAllDisplays()
	if (selectedDisplay !== 'auto') {
		const selected = displays.find(
			(display) => String(display.id) === selectedDisplay || display.label === selectedDisplay,
		)
		if (selected != null) return selected
	}
	return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) ?? screen.getPrimaryDisplay()
}

async function captureScreen({ region = null } = {}) {
	const display = pickDisplay()
	const scale = display.scaleFactor || 1
	const fullWidth = Math.max(1, Math.round(display.size.width * scale))
	const fullHeight = Math.max(1, Math.round(display.size.height * scale))
	const ratio = fullHeight / fullWidth
	const width = Math.min(1600, fullWidth)
	const height = Math.max(1, Math.round(width * ratio))
	const sources = await desktopCapturer.getSources({
		types: ['screen'],
		thumbnailSize: { width, height },
	})
	const matching = sources.find((source) => String(source.display_id) === String(display.id)) ?? sources[0]
	if (matching == null || matching.thumbnail.isEmpty()) throw new Error('Windows did not return a screenshot')
	let image = matching.thumbnail
	if (region != null) {
		const crop = {
			x: Math.max(0, Math.round(region[0])),
			y: Math.max(0, Math.round(region[1])),
			width: Math.max(1, Math.round(region[2] - region[0])),
			height: Math.max(1, Math.round(region[3] - region[1])),
		}
		image = image.crop(crop)
	}
	const file = path.join(os.tmpdir(), `bol-screen-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`)
	await fs.writeFile(file, image.toJPEG(84))
	const size = image.getSize()
	lastCapture = { bounds: display.bounds, width: size.width, height: size.height, displayId: String(display.id) }
	return {
		file,
		text: `Screenshot of ${display.label || 'the primary display'} (${size.width}x${size.height}).`,
		display,
	}
}

async function performControlAction(action) {
	switch (action.name) {
		case 'screenshot': {
			const result = await captureScreen()
			const other = displayChoices()
				.filter((display) => display.id !== String(result.display.id))
				.map((display) => `${display.label} (${display.id})`)
			return {
				text: other.length === 0 ? result.text : `${result.text} Other displays: ${other.join(', ')}.`,
				images: [result.file],
			}
		}
		case 'zoom': {
			const result = await captureScreen({ region: action.region })
			return { text: 'Zoomed screenshot.', images: [result.file] }
		}
		case 'left_click':
		case 'right_click':
		case 'middle_click':
		case 'double_click':
		case 'triple_click':
		case 'mouse_move':
		case 'left_mouse_down':
		case 'left_mouse_up':
		case 'left_click_drag':
		case 'scroll':
			return { text: await performMouseAction(action), images: [] }
		case 'type': {
			const previous = clipboard.readText()
			clipboard.writeText(String(action.text ?? ''))
			await pressKeys('ctrl+v')
			setTimeout(() => clipboard.writeText(previous), 500)
			return { text: 'Typed.', images: [] }
		}
		case 'key':
			await pressKeys(action.text, { repeat: action.repeat ?? 1 })
			return { text: 'Key pressed.', images: [] }
		case 'hold_key':
			await pressKeys(action.text, { holdSeconds: Math.min(30, Number(action.duration ?? 1)) })
			return { text: 'Key held.', images: [] }
		case 'cursor_position': {
			const output = await runPowerShell(
				`${inputPrelude}\n$p=[BolInput]::Cursor()\nWrite-Output "$($p.X),$($p.Y)"`,
			)
			const [x = 0, y = 0] = output.split(',').map(Number)
			if (lastCapture != null) {
				const localX = Math.round(((x - lastCapture.bounds.x) / lastCapture.bounds.width) * lastCapture.width)
				const localY = Math.round(((y - lastCapture.bounds.y) / lastCapture.bounds.height) * lastCapture.height)
				return { text: `Cursor is at [${localX}, ${localY}] in the latest screenshot.`, images: [] }
			}
			return { text: `Cursor is at screen coordinate [${x}, ${y}].`, images: [] }
		}
		case 'open_application': {
			const encoded = utf8Base64(action.app ?? '')
			await runPowerShell(
				`$app=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\nStart-Process $app`,
			)
			return { text: `Opened ${action.app}.`, images: [] }
		}
		case 'switch_display':
			selectedDisplay = String(action.display ?? 'auto')
			return {
				text: selectedDisplay === 'auto' ? 'Following the active display.' : `Capturing ${selectedDisplay}.`,
				images: [],
			}
		case 'read_clipboard':
			return { text: clipboard.readText(), images: [] }
		case 'write_clipboard':
			clipboard.writeText(String(action.text ?? ''))
			return { text: 'Clipboard updated.', images: [] }
		case 'wait':
			await new Promise((resolve) => setTimeout(resolve, Math.min(30, Number(action.duration ?? 1)) * 1000))
			return { text: 'Waited.', images: [] }
		case 'computer_batch': {
			const steps = Array.isArray(action.actions) ? action.actions : []
			const images = []
			const notes = []
			for (const step of steps) {
				const result = await performControlAction(step)
				notes.push(result.text)
				images.push(...result.images)
			}
			return { text: notes.join(' '), images }
		}
		default:
			throw new Error(`Unsupported control action ${action.name}`)
	}
}

async function performControl(id, action) {
	try {
		const result = await performControlAction(action)
		brain?.send({ type: 'controlResult', id, text: result.text, isError: false, images: result.images })
	} catch (error) {
		brain?.send({
			type: 'controlResult',
			id,
			text: error instanceof Error ? error.message : String(error),
			isError: true,
			images: [],
		})
	}
}

async function transcribeAudio({ audio, mimeType }) {
	if (config.openaiApiKey === '') throw new Error('Add an OpenAI API key in Settings to use speech recognition.')
	const buffer = Buffer.from(audio, 'base64')
	const form = new FormData()
	const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm'
	form.append('file', new Blob([buffer], { type: mimeType }), `audio.${extension}`)
	form.append('model', 'whisper-1')
	const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${config.openaiApiKey}` },
		body: form,
	})
	if (!response.ok) throw new Error(`Speech recognition failed (${response.status}): ${await response.text()}`)
	const json = await response.json()
	return json.text ?? ''
}

function wireIpc() {
	ipcMain.handle('bol:get-state', () => ({
		config,
		platform: process.platform,
		isPackaged,
		brainPath,
		displays: displayChoices(),
	}))
	ipcMain.handle('bol:save-settings', async (_event, next) => {
		const hotkeyChanged = next.hotkey !== config.hotkey
		const brainSettingsChanged = ['model', 'effort', 'workingDirectory', 'isChromeEnabled', 'screenAccess'].some(
			(key) => next[key] !== config[key],
		)
		config = { ...config, ...next }
		await saveConfig()
		if (hotkeyChanged) registerHotkey()
		if (brainSettingsChanged) brain?.restart()
		return config
	})
	ipcMain.handle('bol:say', (_event, text) => {
		const seq = Date.now()
		brain?.send({ type: 'say', text, seq })
		return seq
	})
	ipcMain.handle('bol:interrupt', () => brain?.send({ type: 'interrupt' }))
	ipcMain.handle('bol:reset', () => brain?.send({ type: 'reset' }))
	ipcMain.handle('bol:hide', () => hideVoiceWindow())
	ipcMain.handle('bol:open-path', (_event, target) => shell.openPath(target))
	ipcMain.handle('bol:transcribe', (_event, payload) => transcribeAudio(payload))
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
	app.quit()
} else {
	app.on('second-instance', showVoiceWindow)
	app.whenReady().then(async () => {
		await loadConfig()
		createVoiceWindow()
		createTray()
		registerHotkey()
		wireIpc()
		if (isWindows) {
			brain = new BrainBridge()
			brain.start()
		} else {
			sendToWindow('brain-status', { status: 'error', message: 'Bol for Windows must run on Windows.' })
		}
	})
	app.on('before-quit', () => {
		isQuitting = true
		globalShortcut.unregisterAll()
		brain?.stop()
	})
	app.on('window-all-closed', (event) => {
		event.preventDefault?.()
	})
}
