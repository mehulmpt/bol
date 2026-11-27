// look_at_screen: an in-process MCP tool that screenshots the frontmost window.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { IS_WINDOWS, PLATFORM_NAME, SCREEN_MODE } from './constants'
import { controlTools } from './control'
import { sh } from './utils'

const WINDOWS_FRONTMOST_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BolWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$hwnd = [BolWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 1024
[void][BolWindow]::GetWindowText($hwnd, $builder, $builder.Capacity)
$targetPid = 0
[void][BolWindow]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
$app = ""
try { $app = (Get-Process -Id $targetPid -ErrorAction Stop).ProcessName } catch {}
$rect = New-Object BolWindow+RECT
[void][BolWindow]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output $app
Write-Output $builder.ToString()
Write-Output "$($rect.Left),$($rect.Top),$width,$height"
`

function windowsCaptureScript({ file, bounds }: { file: string; bounds: number[] | null }) {
	const escaped = file.replaceAll("'", "''")
	const source =
		bounds == null
			? `
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = $screen.Left
$y = $screen.Top
$width = $screen.Width
$height = $screen.Height`
			: `
$x = ${Math.round(bounds[0] ?? 0)}
$y = ${Math.round(bounds[1] ?? 0)}
$width = ${Math.max(1, Math.round(bounds[2] ?? 1))}
$height = ${Math.max(1, Math.round(bounds[3] ?? 1))}`
	return `
Add-Type -AssemblyName System.Drawing
${source}
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
if ($width -gt 1600) {
  $scale = 1600 / $width
  $targetWidth = 1600
  $targetHeight = [Math]::Max(1, [int]($height * $scale))
  $resized = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
  $resizedGraphics = [System.Drawing.Graphics]::FromImage($resized)
  $resizedGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizedGraphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
  $graphics.Dispose()
  $bitmap.Dispose()
  $bitmap = $resized
} else {
  $graphics.Dispose()
}
$bitmap.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bitmap.Dispose()
`
}

/** Frontmost app, window title and (for browsers on macOS) the current URL. */
async function frontmostContext(): Promise<{ app: string; title: string; url: string; bounds: number[] | null }> {
	if (IS_WINDOWS) {
		const info = await sh({
			cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_FRONTMOST_SCRIPT],
		})
		const [app = '', title = '', b = ''] = info.split('\n')
		const nums = b.trim().split(',').map(Number)
		return {
			app: app.trim(),
			title: title.trim(),
			url: '',
			bounds: nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? nums : null,
		}
	}
	const info = await sh({
		cmd: [
			'osascript',
			'-e',
			`
    tell application "System Events"
      set p to first process whose frontmost is true
      set appName to name of p
      set winTitle to ""
      set b to ""
      try
        set w to front window of p
        set winTitle to name of w
        set {x, y} to position of w
        set {ww, hh} to size of w
        set b to (x as text) & "," & (y as text) & "," & (ww as text) & "," & (hh as text)
      end try
      return appName & linefeed & winTitle & linefeed & b
    end tell`,
		],
	})
	const [app = '', title = '', b = ''] = info.split('\n')
	let url = ''
	try {
		if (/chrome/i.test(app))
			url = await sh({
				cmd: ['osascript', '-e', 'tell application "Google Chrome" to get URL of active tab of front window'],
			})
		else if (/safari/i.test(app))
			url = await sh({ cmd: ['osascript', '-e', 'tell application "Safari" to get URL of front document'] })
		else if (/arc/i.test(app))
			url = await sh({
				cmd: ['osascript', '-e', 'tell application "Arc" to get URL of active tab of front window'],
			})
	} catch {}
	const nums = b.split(',').map(Number)
	return { app, title, url, bounds: nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? nums : null }
}

const makeLookAtScreen = ({ onScreen }: { onScreen: (event: { reason: string }) => void }) =>
	tool(
		'look_at_screen',
		`See what the user is looking at on their ${PLATFORM_NAME} right now: returns a screenshot plus the frontmost app, window title and browser URL when available. ` +
			"Use it when the request refers to something on screen or needs visual context. Prefer scope 'window' (the frontmost window); use 'screen' for the whole display.",
		{
			reason: z.string().describe('A few words on why you need to look, shown to the user'),
			scope: z.enum(['window', 'screen']).optional().describe('Default: window'),
		},
		async ({ reason, scope }) => {
			onScreen({ reason })
			const ctx = await frontmostContext()
			const file = join(tmpdir(), `bol-screen-${Date.now()}.jpg`)
			if (IS_WINDOWS) {
				const crop = (scope ?? 'window') === 'window' ? ctx.bounds : null
				await sh({
					cmd: [
						'powershell',
						'-NoProfile',
						'-NonInteractive',
						'-Command',
						windowsCaptureScript({ file, bounds: crop }),
					],
				})
			} else {
				const args = ['screencapture', '-x', '-t', 'jpg']
				if ((scope ?? 'window') === 'window' && ctx.bounds != null) args.push('-R', ctx.bounds.join(','))
				args.push(file)
				await sh({ cmd: args })
			}
			let image = ''
			try {
				if (!IS_WINDOWS) await sh({ cmd: ['sips', '-Z', '1600', file] }) // keep it readable but small
				image = (await readFile(file)).toString('base64')
			} catch {}
			await unlink(file).catch(() => {})
			const lines = [`Frontmost app: ${ctx.app === '' ? 'unknown' : ctx.app}`]
			if (ctx.title !== '') lines.push(`Window: ${ctx.title}`)
			if (ctx.url !== '') lines.push(`URL: ${ctx.url}`)
			const text = lines.join('\n')
			if (image === '') {
				return {
					content: [
						{
							type: 'text',
							text:
								text +
								`\n(Screenshot failed${IS_WINDOWS ? '' : ': Bol may need Screen Recording permission'}.)`,
						},
					],
					isError: true,
				}
			}
			return {
				content: [
					{ type: 'text', text },
					{ type: 'image', data: image, mimeType: 'image/jpeg' },
				],
			}
		},
	)

/** Bol's own tools. An SDK MCP server serves one query at a time, so each conversation makes its own. */
export function makeBolTools({
	onScreen,
	extraTools,
}: {
	onScreen: (event: { reason: string }) => void
	/** The thread's task tools. */
	extraTools: ReturnType<typeof tool<any>>[]
}) {
	return createSdkMcpServer({
		name: 'bol',
		version: '1.0.0',
		tools: [...(SCREEN_MODE === 'off' ? [] : [makeLookAtScreen({ onScreen }), ...controlTools]), ...extraTools],
	})
}
