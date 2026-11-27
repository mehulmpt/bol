const statusElement = document.getElementById('status')
const detailElement = document.getElementById('detail')
const replyElement = document.getElementById('reply')
const inputElement = document.getElementById('text-input')
const micButton = document.getElementById('mic-button')
const sendButton = document.getElementById('send-button')
const closeButton = document.getElementById('close-button')
const settingsButton = document.getElementById('settings-button')
const settingsDialog = document.getElementById('settings-dialog')
const settingsForm = document.getElementById('settings-form')
const resetButton = document.getElementById('reset-button')

const fields = {
	openaiApiKey: document.getElementById('setting-openai'),
	model: document.getElementById('setting-model'),
	effort: document.getElementById('setting-effort'),
	workingDirectory: document.getElementById('setting-cwd'),
	hotkey: document.getElementById('setting-hotkey'),
	screenAccess: document.getElementById('setting-screen'),
	isChromeEnabled: document.getElementById('setting-chrome'),
	speakReplies: document.getElementById('setting-speak'),
	openAtLogin: document.getElementById('setting-login'),
	isSilentMode: document.getElementById('setting-silent'),
}

let config = null
let stream = null
let recorder = null
let chunks = []
let isListening = false
let isBusy = false
let cancelListening = false
let latestActivity = ''

function setState(state, detail = '') {
	document.body.classList.toggle('listening', state === 'listening')
	document.body.classList.toggle('working', state === 'working')
	document.body.classList.toggle('error', state === 'error')
	const labels = {
		ready: 'Ready',
		listening: 'Listening…',
		transcribing: 'Transcribing…',
		working: 'Working…',
		error: 'Needs attention',
	}
	statusElement.textContent = labels[state] ?? state
	if (detail !== '') detailElement.textContent = detail
}

function setReply(text, kind = '') {
	replyElement.className = kind
	replyElement.textContent = text
}

function speak(text) {
	if (!config?.speakReplies || config.isSilentMode || text.trim() === '') return
	window.speechSynthesis.cancel()
	const utterance = new SpeechSynthesisUtterance(text)
	utterance.rate = 1.03
	utterance.pitch = 1
	window.speechSynthesis.speak(utterance)
}

function stopTracks() {
	if (stream != null) for (const track of stream.getTracks()) track.stop()
	stream = null
}

async function startListening() {
	if (isListening || isBusy) return
	if (!config?.openaiApiKey) {
		setState('ready', 'Add an OpenAI key in Settings, or type instead.')
		inputElement.focus()
		return
	}
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: 'audio/webm'
		chunks = []
		cancelListening = false
		recorder = new MediaRecorder(stream, { mimeType })
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data)
		}
		recorder.onstop = () => void finishTranscription(mimeType)
		recorder.start()
		isListening = true
		setState('listening', 'Enter sends; Esc cancels.')
	} catch (error) {
		setState('error', `Microphone unavailable: ${error.message}`)
	}
}

function stopListening({ cancel = false } = {}) {
	if (!isListening || recorder == null) return
	cancelListening = cancel
	isListening = false
	recorder.stop()
	stopTracks()
	if (cancel) setState('ready', 'Cancelled.')
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error)
		reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
		reader.readAsDataURL(blob)
	})
}

async function finishTranscription(mimeType) {
	if (cancelListening) return
	if (chunks.length === 0) {
		setState('ready', 'Nothing heard.')
		return
	}
	setState('transcribing', 'Turning speech into text…')
	try {
		const blob = new Blob(chunks, { type: mimeType })
		const audio = await blobToBase64(blob)
		const text = (await window.bol.transcribe({ audio, mimeType })).trim()
		if (text === '') {
			setState('ready', 'Nothing recognized.')
			return
		}
		await sendText(text)
	} catch (error) {
		setState('error', error.message)
	}
}

async function sendText(text) {
	const trimmed = text.trim()
	if (trimmed === '' || isBusy) return
	isBusy = true
	latestActivity = ''
	inputElement.value = ''
	setReply(`“${trimmed}”`, 'user')
	setState('working', 'Claude is thinking…')
	await window.bol.say(trimmed)
}

function interrupt() {
	window.speechSynthesis.cancel()
	if (isListening) stopListening({ cancel: true })
	else if (isBusy) {
		window.bol.interrupt()
		isBusy = false
		setState('ready', 'Stopped.')
	} else window.bol.hide()
}

function fillSettings() {
	fields.openaiApiKey.value = config.openaiApiKey ?? ''
	fields.model.value = config.model
	fields.effort.value = config.effort
	fields.workingDirectory.value = config.workingDirectory ?? ''
	fields.hotkey.value = config.hotkey
	fields.screenAccess.value = config.screenAccess
	fields.isChromeEnabled.checked = Boolean(config.isChromeEnabled)
	fields.speakReplies.checked = Boolean(config.speakReplies)
	fields.openAtLogin.checked = Boolean(config.openAtLogin)
	fields.isSilentMode.checked = Boolean(config.isSilentMode)
}

function openSettings() {
	fillSettings()
	if (!settingsDialog.open) settingsDialog.showModal()
}

async function saveSettings(event) {
	event.preventDefault()
	const next = {
		openaiApiKey: fields.openaiApiKey.value.trim(),
		model: fields.model.value,
		effort: fields.effort.value,
		workingDirectory: fields.workingDirectory.value.trim(),
		hotkey: fields.hotkey.value.trim() || 'Control+J',
		screenAccess: fields.screenAccess.value,
		isChromeEnabled: fields.isChromeEnabled.checked,
		speakReplies: fields.speakReplies.checked,
		openAtLogin: fields.openAtLogin.checked,
		isSilentMode: fields.isSilentMode.checked,
	}
	config = await window.bol.saveSettings(next)
	settingsDialog.close()
	setState('ready', 'Settings saved.')
}

function handleBrainEvent(event) {
	if (event.type === 'ready') {
		setState('ready', 'Claude is ready.')
		return
	}
	if (event.type === 'tool') {
		latestActivity = event.summary || event.name
		setState('working', latestActivity)
		return
	}
	if (event.type === 'screen') {
		setState('working', event.reason ? `Looking: ${event.reason}` : 'Looking at the screen…')
		return
	}
	if (event.type === 'text') {
		if (!isBusy) return
		detailElement.textContent = event.text.slice(-180)
		return
	}
	if (event.type === 'result') {
		isBusy = false
		setReply(event.text || (event.isError ? 'Something went wrong.' : 'Done.'), event.isError ? 'empty' : '')
		setState(
			event.isError ? 'error' : 'ready',
			event.isError ? 'Claude reported an error.' : 'Ctrl+J anywhere to talk',
		)
		if (!event.isError) speak(event.text)
		return
	}
	if (event.type === 'idle') {
		isBusy = false
		if (!document.body.classList.contains('error')) setState('ready', 'Ctrl+J anywhere to talk')
		return
	}
	if (event.type === 'task') {
		setState('working', `${event.name}: ${event.status}`)
		return
	}
	if (event.type === 'mcpSignInDone') {
		detailElement.textContent = `${event.name}: ${event.status}`
	}
}

window.bol.onEvent((payload) => {
	if (payload.type === 'shown') {
		inputElement.focus()
		startListening()
		return
	}
	if (payload.type === 'hidden') {
		window.speechSynthesis.cancel()
		if (isListening) stopListening({ cancel: true })
		return
	}
	if (payload.type === 'open-settings') {
		openSettings()
		return
	}
	if (payload.type === 'brain-status') {
		if (payload.status === 'error') setState('error', payload.message)
		else if (payload.status === 'ready') setState('ready', 'Claude is ready.')
		else setState('working', payload.message)
		return
	}
	if (payload.type === 'error') {
		setState('error', payload.message)
		return
	}
	if (payload.type === 'brain-event') handleBrainEvent(payload.event)
})

micButton.addEventListener('click', () => {
	if (isListening) stopListening()
	else startListening()
})
sendButton.addEventListener('click', () => sendText(inputElement.value))
closeButton.addEventListener('click', () => window.bol.hide())
settingsButton.addEventListener('click', openSettings)
settingsForm.addEventListener('submit', saveSettings)
resetButton.addEventListener('click', () => {
	window.bol.reset()
	settingsDialog.close()
	setReply('New conversation started.', 'empty')
})

inputElement.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') sendText(inputElement.value)
	if (event.key === 'Escape') interrupt()
})

document.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && document.activeElement !== inputElement && isListening) {
		event.preventDefault()
		stopListening()
	}
	if (event.key === 'Escape' && !settingsDialog.open) interrupt()
})

async function initialize() {
	const state = await window.bol.getState()
	config = state.config
	fillSettings()
	if (!state.isPackaged) detailElement.textContent = 'Development build'
	if (!config.openaiApiKey) setState('ready', 'Type below, or add an OpenAI key for voice.')
	else setState('ready', 'Ctrl+J anywhere to talk')
	inputElement.focus()
}

initialize()
