// Signing in to MCP servers that need OAuth ("needs-auth"), without a trip to Claude Code's /mcp:
// Claude Code starts the OAuth flow and listens for its callback; Bol opens the sign-in page in the
// browser. Also answers servers that ask for a browser sign-in mid-call (URL elicitation).

import type { OnElicitation, Query } from '@anthropic-ai/claude-agent-sdk'
import { IS_WINDOWS } from './constants'
import { emit, log } from './protocol'
import { sh } from './utils'

/**
 * Claude Code serves `mcp_authenticate` to SDK sessions, and the SDK's query has the method, but it isn't
 * in the SDK's published types yet; checked for at runtime.
 */
type SignInCapable = { mcpAuthenticate: (serverName: string) => Promise<unknown> }

function canSignIn(query: Query): query is Query & SignInCapable {
	return typeof (query as Partial<SignInCapable>).mcpAuthenticate === 'function'
}

/** The first http(s) URL anywhere in a reply whose exact shape isn't published. */
export function findUrl(value: unknown): string | null {
	if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : null
	if (Array.isArray(value)) {
		for (const item of value) {
			const url = findUrl(item)
			if (url != null) return url
		}
		return null
	}
	if (value != null && typeof value === 'object') {
		for (const item of Object.values(value)) {
			const url = findUrl(item)
			if (url != null) return url
		}
	}
	return null
}

/** Opens a sign-in page in the default browser. Only web pages: never a file or another app's URL scheme. */
async function openInBrowser({ url }: { url: string }): Promise<boolean> {
	if (!/^https?:\/\//.test(url)) return false
	if (IS_WINDOWS) {
		const escaped = url.replaceAll("'", "''")
		await sh({
			cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${escaped}'`],
		})
	} else {
		await sh({ cmd: ['open', url] })
	}
	return true
}

/** Starts the server's sign-in and opens its page. Returns what to tell the user (or the model). */
export async function signIn({ query, server }: { query: Query; server: string }): Promise<string> {
	if (!canSignIn(query)) {
		const error = "This version of Claude Code can't sign in to MCP servers from Bol. Run /mcp in Claude Code."
		emit({ type: 'mcpSignIn', name: server, url: null, error })
		return error
	}
	try {
		const reply = await query.mcpAuthenticate(server)
		log({ msg: `mcp sign-in ${server}: ${JSON.stringify(reply).slice(0, 400)}` })
		const url = findUrl(reply)
		if (url != null) await openInBrowser({ url })
		emit({ type: 'mcpSignIn', name: server, url, error: null })
		void watchSignIn({ query, server })
		return url == null
			? `Signing in to ${server}; it may already be done.`
			: `Opened ${server}'s sign-in page in the browser. It connects once the user finishes there.`
	} catch (e) {
		const error = e instanceof Error ? e.message : String(e)
		log({ msg: `mcp sign-in ${server} failed: ${error}` })
		emit({ type: 'mcpSignIn', name: server, url: null, error })
		return `Couldn't start signing in to ${server}: ${error}`
	}
}

/** Waits (up to five minutes) for the server to connect after the browser sign-in, nudging it now and then. */
async function watchSignIn({ query, server }: { query: Query; server: string }) {
	for (let tick = 1; tick <= 100; tick++) {
		await Bun.sleep(3000)
		const statuses = await query.mcpServerStatus().catch(() => null)
		const status = statuses?.find((s) => s.name === server)?.status
		if (status == null || status === 'connected' || status === 'failed' || status === 'disabled') {
			log({ msg: `mcp sign-in ${server}: ${status ?? 'gone'}` })
			emit({ type: 'mcpSignInDone', name: server, status: status ?? 'gone' })
			return
		}
		// The tokens land when the browser comes back; a reconnect picks them up.
		if (tick % 5 === 0) await query.reconnectMcpServer(server).catch(() => {})
	}
	log({ msg: `mcp sign-in ${server}: timed out` })
	emit({ type: 'mcpSignInDone', name: server, status: 'needs-auth' })
}

/** A server asks for something mid-call: a browser sign-in is opened; a form is declined (Bol can't fill one in yet). */
export const answerElicitation: OnElicitation = async (request) => {
	if (request.mode === 'url' && request.url != null && (await openInBrowser({ url: request.url }))) {
		log({ msg: `mcp ${request.serverName} asked for a browser sign-in` })
		emit({ type: 'mcpSignIn', name: request.serverName, url: request.url, error: null })
		return { action: 'accept' }
	}
	log({ msg: `mcp ${request.serverName} asked for input Bol can't give: ${request.message.slice(0, 200)}` })
	return { action: 'decline' }
}
