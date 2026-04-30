import type { SessionEndReason } from '@hapi/protocol'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type {
    NotificationChannel,
    TaskNotification
} from '../notifications/notificationTypes'
import { isFailureStatus } from '../notifications/notificationTypes'
import { WsCmd, type EventBody, type SendMsgBody, type TextMessageBody, type WsFrame } from './types'
import { WecomWSClient } from './client'
import { handleTemplateCardEvent, type CallbackCtx } from './callbacks'
import {
    buildPermissionCard,
    buildReadyCard,
    buildSessionCompletionCard,
    buildTaskCard
} from './sessionView'

export interface WecomBotConfig {
    botId: string
    secret: string
    cliApiToken: string
    publicUrl: string
    store: Store
    syncEngine: SyncEngine
    /** Pre-constructed client; if omitted, a real WecomWSClient is instantiated. */
    client?: WecomWSClient
    /** Optional logger; falls back to console. Supports optional debug level. */
    logger?: {
        debug?: (msg: string, ...args: unknown[]) => void
        info?: (msg: string, ...args: unknown[]) => void
        warn?: (msg: string, ...args: unknown[]) => void
        error?: (msg: string, ...args: unknown[]) => void
    }
}

export class WecomBot implements NotificationChannel {
    private readonly store: Store
    private readonly syncEngine: SyncEngine
    private readonly cliApiToken: string
    private readonly publicUrl: string
    private readonly client: WecomWSClient
    private readonly logger: NonNullable<WecomBotConfig['logger']>

    constructor(config: WecomBotConfig) {
        this.store = config.store
        this.syncEngine = config.syncEngine
        this.cliApiToken = config.cliApiToken
        this.publicUrl = config.publicUrl
        this.logger = config.logger ?? {}
        this.client = config.client ?? new WecomWSClient({
            botId: config.botId,
            secret: config.secret
        })
        this.client.onMessage = (frame) => this.onTextMessage(frame)
        this.client.onEvent = (frame) => this.onEvent(frame)
    }

    start(): void {
        this.client.start()
    }

    stop(): void {
        this.client.stop()
    }

    // --- NotificationChannel ---

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) return
        const card = buildPermissionCard(session, this.publicUrl)
        if (!card) return
        const chatids = this.bindingsFor(session.namespace)
        if (chatids.length === 0) return
        for (const chatid of chatids) {
            this.client.send(WsCmd.SEND_MSG, {
                chatid,
                msgtype: 'template_card',
                template_card: card
            })
        }
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) return
        const card = buildReadyCard(session, this.publicUrl)
        for (const chatid of this.bindingsFor(session.namespace)) {
            this.client.send(WsCmd.SEND_MSG, {
                chatid,
                msgtype: 'template_card',
                template_card: card
            })
        }
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) return
        if (!isFailureStatus(notification.status)) return
        const card = buildTaskCard(session, notification, this.publicUrl)
        for (const chatid of this.bindingsFor(session.namespace)) {
            this.client.send(WsCmd.SEND_MSG, {
                chatid,
                msgtype: 'template_card',
                template_card: card
            })
        }
    }

    async sendSessionCompletion(session: Session, _reason: SessionEndReason): Promise<void> {
        const card = buildSessionCompletionCard(session, this.publicUrl)
        for (const chatid of this.bindingsFor(session.namespace)) {
            this.client.send(WsCmd.SEND_MSG, {
                chatid,
                msgtype: 'template_card',
                template_card: card
            })
        }
    }

    // --- Incoming frames ---

    private onTextMessage(frame: WsFrame<TextMessageBody>): void {
        const content = frame.body?.text?.content?.trim()
        const userid = frame.body?.from?.userid
        if (!content || !userid) return

        const prefix = `${this.cliApiToken}:`
        if (!content.startsWith(prefix)) return
        const namespace = content.slice(prefix.length).trim()
        if (!namespace) return

        // Whitelist: letters, digits, dash, underscore, up to 64 chars.
        // Rejects markdown metacharacters that would break the confirmation
        // card and keeps the `users.namespace` column to a known charset.
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) {
            this.sendBindReply(userid,
                'Invalid namespace. Allowed: letters, digits, `-`, `_`, max 64 chars.')
            return
        }

        const existing = this.store.users.getUser('wecom', userid)
        if (existing) {
            if (existing.namespace === namespace) {
                this.sendBindReply(userid,
                    `Already bound to namespace **${namespace}**.`)
            } else {
                // Refuse to silently no-op: surface the conflict.
                this.sendBindReply(userid,
                    `Already bound to a different namespace. Unbind first before rebinding.`)
            }
            return
        }

        try {
            this.store.users.addUser('wecom', userid, namespace)
        } catch (err) {
            console.error('[WecomBot] failed to persist binding:', err)
            return
        }
        this.sendBindReply(userid,
            `Bound WeCom user **${userid}** to namespace **${namespace}**.`)
    }

    private sendBindReply(chatid: string, content: string): void {
        this.client.send(WsCmd.SEND_MSG, {
            chatid,
            msgtype: 'markdown',
            markdown: { content }
        })
    }

    private onEvent(frame: WsFrame<EventBody>): void {
        const event = frame.body?.event
        const eventtype = event?.eventtype ?? '(none)'
        // See note in callbacks.ts: click details live under event.template_card_event.*
        // on the live wire, with flat fallback for older payloads.
        const details =
            (event as { template_card_event?: { event_key?: string; task_id?: string } } | undefined)
                ?.template_card_event ?? {}
        const eventKey =
            details.event_key ??
            (event as { event_key?: string } | undefined)?.event_key
        const taskId =
            details.task_id ??
            (event as { task_id?: string } | undefined)?.task_id
        this.logger.debug?.(
            `[WecomBot] onEvent eventtype=${eventtype} event_key=${eventKey ?? '(none)'} task_id=${taskId ?? '(none)'}`
        )
        if (!event) return
        if (event.eventtype !== 'template_card_event') {
            this.logger.debug?.(`[WecomBot] onEvent: ignoring non-click event type=${event.eventtype}`)
            return
        }

        const ctx: CallbackCtx = {
            syncEngine: this.syncEngine,
            store: this.store,
            publicUrl: this.publicUrl,
            sendUpdate: (payload) => {
                // Update-card responses must reuse the callback's req_id.
                this.logger.debug?.(
                    `[WecomBot] sending update_template_card reply req_id=${payload.reqId} task_id=${payload.body.template_card.task_id ?? '(none)'}`
                )
                this.client.sendWithReqId(WsCmd.RESPONSE_UPDATE, payload.reqId, payload.body)
            }
        }
        void handleTemplateCardEvent(frame, ctx).catch((err) => {
            (this.logger.error ?? console.error)('[WecomBot] handleTemplateCardEvent failed:', err)
        })
    }

    private bindingsFor(namespace: string): string[] {
        return this.store.users
            .getUsersByPlatformAndNamespace('wecom', namespace)
            .map((u) => u.platformUserId)
    }
}
