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
}

export class WecomBot implements NotificationChannel {
    private readonly store: Store
    private readonly syncEngine: SyncEngine
    private readonly cliApiToken: string
    private readonly publicUrl: string
    private readonly client: WecomWSClient

    constructor(config: WecomBotConfig) {
        this.store = config.store
        this.syncEngine = config.syncEngine
        this.cliApiToken = config.cliApiToken
        this.publicUrl = config.publicUrl
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

        try {
            this.store.users.addUser('wecom', userid, namespace)
        } catch (err) {
            console.error('[WecomBot] failed to persist binding:', err)
            return
        }
        this.client.send(WsCmd.SEND_MSG, {
            chatid: userid,
            msgtype: 'markdown',
            markdown: { content: `Bound WeCom user **${userid}** to namespace **${namespace}**` }
        })
    }

    private onEvent(frame: WsFrame<EventBody>): void {
        const event = frame.body?.event
        if (!event) return
        if (event.eventtype !== 'template_card_event') return

        const ctx: CallbackCtx = {
            syncEngine: this.syncEngine,
            store: this.store,
            sendUpdate: (payload) => {
                // Update-card responses must reuse the callback's req_id.
                this.client.sendWithReqId(WsCmd.RESPONSE_UPDATE, payload.reqId, payload.body)
            }
        }
        void handleTemplateCardEvent(frame, ctx).catch((err) => {
            console.error('[WecomBot] handleTemplateCardEvent failed:', err)
        })
    }

    private bindingsFor(namespace: string): string[] {
        return this.store.users
            .getUsersByPlatformAndNamespace('wecom', namespace)
            .map((u) => u.platformUserId)
    }
}
