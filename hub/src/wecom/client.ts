/**
 * WecomWSClient — WebSocket long connection to the WeCom smart robot endpoint.
 *
 * Lifecycle:
 *   disconnected -> connecting -> subscribing -> ready
 *                                         |
 *                                  subscribe error -> fatal (no retry)
 *
 *   socket close / missed pong / subscribe timeout
 *       -> exponential backoff -> connecting -> ...
 *
 * Exposes:
 *   start() / stop()
 *   send(cmd, body) — fire-and-forget; queued when not ready (bounded FIFO)
 *   onMessage(frame) — called for aibot_msg_callback
 *   onEvent(frame)   — called for aibot_event_callback
 */

import {
    WS_URL,
    WsCmd,
    type WsFrame,
    type TextMessageBody,
    type EventBody,
    type SendMsgBody,
    type UpdateTemplateCardBody,
    type SubscribeBody
} from './types'

export interface WecomWSClientOptions {
    botId: string
    secret: string
    url?: string
    heartbeatIntervalMs?: number
    maxBackoffMs?: number
    initialBackoffMs?: number
    pendingQueueSize?: number
    kickedPauseMs?: number
    webSocketConstructor?: typeof WebSocket
    logger?: {
        info: (msg: string, ...args: unknown[]) => void
        warn: (msg: string, ...args: unknown[]) => void
        error: (msg: string, ...args: unknown[]) => void
    }
}

type ClientState = 'disconnected' | 'connecting' | 'subscribing' | 'ready' | 'fatal'

type QueuedFrame = {
    cmd: string
    body: SendMsgBody | UpdateTemplateCardBody
    reqId: string
}

export class WecomWSClient {
    private readonly options: Required<Omit<WecomWSClientOptions, 'logger' | 'webSocketConstructor'>>
        & Pick<WecomWSClientOptions, 'logger' | 'webSocketConstructor'>
    private ws: WebSocket | null = null
    private state: ClientState = 'disconnected'
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private pongTimer: ReturnType<typeof setTimeout> | null = null
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private reconnectAttempt = 0
    private pendingFrames: QueuedFrame[] = []
    private stopped = true
    private reqCounter = 0
    private kickedUntil = 0

    onMessage: ((frame: WsFrame<TextMessageBody>) => void) | null = null
    onEvent: ((frame: WsFrame<EventBody>) => void) | null = null

    constructor(options: WecomWSClientOptions) {
        this.options = {
            url: WS_URL,
            heartbeatIntervalMs: 30_000,
            maxBackoffMs: 30_000,
            initialBackoffMs: 1_000,
            pendingQueueSize: 100,
            kickedPauseMs: 30_000,
            ...options
        }
    }

    start(): void {
        if (!this.stopped) return
        this.stopped = false
        this.connect()
    }

    stop(): void {
        if (this.stopped) return
        this.stopped = true
        this.clearTimers()
        this.pendingFrames = []
        if (this.ws) {
            try { this.ws.close() } catch { /* ignore */ }
            this.ws = null
        }
        this.state = 'disconnected'
    }

    /**
     * Send a frame. If the connection is not in the 'ready' state, the frame is
     * queued (bounded FIFO) and flushed on the next subscribe success. Subscribe
     * and heartbeat frames bypass the queue — they are driven by state transitions.
     */
    send(cmd: string, body: SendMsgBody | UpdateTemplateCardBody): void {
        const reqId = this.nextReqId('msg')
        this.enqueueOrWrite(cmd, reqId, body)
    }

    /**
     * Like {@link send}, but uses the caller-provided req_id. Required for
     * `aibot_respond_update_msg` replies which must reuse the callback's req_id.
     */
    sendWithReqId(cmd: string, reqId: string, body: SendMsgBody | UpdateTemplateCardBody): void {
        this.enqueueOrWrite(cmd, reqId, body)
    }

    private enqueueOrWrite(
        cmd: string,
        reqId: string,
        body: SendMsgBody | UpdateTemplateCardBody
    ): void {
        if (this.state === 'ready') {
            this.writeFrame(cmd, reqId, body)
            return
        }
        if (this.state === 'fatal' || this.stopped) {
            this.logger.warn(`[WecomWSClient] dropping frame cmd=${cmd}: client stopped or in fatal state`)
            return
        }
        if (this.pendingFrames.length >= this.options.pendingQueueSize) {
            this.pendingFrames.shift() // drop oldest
            this.logger.warn('[WecomWSClient] pending queue overflow; dropping oldest frame')
        }
        this.pendingFrames.push({ cmd, body, reqId })
    }

    private get logger() {
        return this.options.logger ?? console
    }

    private nextReqId(prefix: string): string {
        this.reqCounter += 1
        return `${prefix}-${Date.now().toString(36)}-${this.reqCounter}`
    }

    private connect(): void {
        if (this.stopped || this.state === 'fatal') return
        if (this.kickedUntil > Date.now()) {
            this.scheduleReconnect(Math.max(this.options.initialBackoffMs, this.kickedUntil - Date.now()))
            return
        }

        this.state = 'connecting'
        const WS = this.options.webSocketConstructor ?? WebSocket
        try {
            this.ws = new WS(this.options.url) as WebSocket
            this.ws.binaryType = 'arraybuffer'
        } catch (err) {
            this.logger.error('[WecomWSClient] failed to create WebSocket:', err)
            this.scheduleReconnect()
            return
        }

        this.ws.addEventListener('open', () => this.handleOpen())
        this.ws.addEventListener('message', (ev) => this.handleMessage(ev))
        this.ws.addEventListener('close', () => this.handleClose('socket-close'))
        this.ws.addEventListener('error', () => this.handleClose('socket-error'))
    }

    private handleOpen(): void {
        this.state = 'subscribing'
        const reqId = this.nextReqId('sub')
        const body: SubscribeBody = { bot_id: this.options.botId, secret: this.options.secret }
        this.writeFrame(WsCmd.SUBSCRIBE, reqId, body, { expectSubscribe: reqId })
    }

    private subscribeReqId: string | null = null
    private subscribeTimeout: ReturnType<typeof setTimeout> | null = null

    private writeFrame(
        cmd: string,
        reqId: string,
        body: unknown,
        options?: { expectSubscribe?: string }
    ): void {
        if (!this.ws) return
        if (options?.expectSubscribe) {
            this.subscribeReqId = options.expectSubscribe
            this.subscribeTimeout = setTimeout(() => {
                this.logger.warn('[WecomWSClient] subscribe timed out')
                this.handleClose('subscribe-timeout')
            }, 10_000)
        }
        try {
            this.ws.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }))
        } catch (err) {
            this.logger.error(`[WecomWSClient] send failed cmd=${cmd}:`, err)
            this.handleClose('send-error')
        }
    }

    private handleMessage(ev: MessageEvent): void {
        if (this.stopped) return
        let frame: WsFrame
        try {
            const raw = ev.data
            let text: string
            if (typeof raw === 'string') {
                text = raw
            } else if (raw instanceof ArrayBuffer) {
                text = new TextDecoder().decode(raw)
            } else {
                // Blob or other — WeCom only sends text; log and bail.
                this.logger.warn('[WecomWSClient] ignoring non-text frame')
                return
            }
            frame = JSON.parse(text)
        } catch (err) {
            this.logger.warn('[WecomWSClient] failed to parse frame:', err)
            return
        }

        // Subscribe response (no cmd, just echoed req_id + errcode)
        if (this.state === 'subscribing' && this.subscribeReqId && frame.headers?.req_id === this.subscribeReqId) {
            if (this.subscribeTimeout) {
                clearTimeout(this.subscribeTimeout)
                this.subscribeTimeout = null
            }
            this.subscribeReqId = null
            if (frame.errcode === 0) {
                this.becomeReady()
            } else {
                this.logger.error(
                    `[WecomWSClient] subscribe failed errcode=${frame.errcode} errmsg=${frame.errmsg}`
                )
                this.state = 'fatal'
                this.stop()
            }
            return
        }

        // Pong
        if (frame.cmd == null && typeof frame.headers?.req_id === 'string' && frame.headers.req_id.startsWith('hb-')) {
            if (this.pongTimer) {
                clearTimeout(this.pongTimer)
                this.pongTimer = null
            }
            return
        }

        switch (frame.cmd) {
            case WsCmd.MSG_CALLBACK:
                this.onMessage?.(frame as WsFrame<TextMessageBody>)
                return
            case WsCmd.EVENT_CALLBACK: {
                const event = (frame as WsFrame<EventBody>).body?.event
                if (event?.eventtype === 'disconnected_event') {
                    this.logger.warn('[WecomWSClient] server kicked old connection')
                    this.kickedUntil = Date.now() + this.options.kickedPauseMs
                    this.handleClose('kicked')
                    return
                }
                this.onEvent?.(frame as WsFrame<EventBody>)
                return
            }
            default:
                // Unknown frame — ignore
                return
        }
    }

    private becomeReady(): void {
        this.state = 'ready'
        this.reconnectAttempt = 0
        this.logger.info('[WecomWSClient] subscribed; connection ready')
        // Flush queue
        const queued = this.pendingFrames
        this.pendingFrames = []
        for (const frame of queued) {
            this.writeFrame(frame.cmd, frame.reqId, frame.body)
        }
        // Start heartbeat
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.options.heartbeatIntervalMs)
    }

    private sendHeartbeat(): void {
        if (this.state !== 'ready' || !this.ws) return
        const reqId = `hb-${++this.reqCounter}`
        try {
            this.ws.send(JSON.stringify({ cmd: WsCmd.HEARTBEAT, headers: { req_id: reqId } }))
        } catch (err) {
            this.logger.warn('[WecomWSClient] heartbeat send failed:', err)
            this.handleClose('heartbeat-send-error')
            return
        }
        this.pongTimer = setTimeout(() => {
            this.logger.warn('[WecomWSClient] missed pong; reconnecting')
            this.handleClose('missed-pong')
        }, 10_000)
    }

    private handleClose(reason: string): void {
        if (this.stopped) return
        this.clearTimers()
        if (this.ws) {
            try { this.ws.close() } catch { /* ignore */ }
            this.ws = null
        }
        if (this.state === 'fatal') return
        this.state = 'disconnected'
        this.logger.warn(`[WecomWSClient] connection closed (${reason}); scheduling reconnect`)
        this.scheduleReconnect()
    }

    private scheduleReconnect(overrideMs?: number): void {
        if (this.stopped || this.state === 'fatal') return
        const backoff = overrideMs ?? Math.min(
            this.options.initialBackoffMs * 2 ** this.reconnectAttempt,
            this.options.maxBackoffMs
        )
        this.reconnectAttempt += 1
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, backoff)
    }

    private clearTimers(): void {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
        if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
        if (this.subscribeTimeout) { clearTimeout(this.subscribeTimeout); this.subscribeTimeout = null }
        this.subscribeReqId = null
    }
}
