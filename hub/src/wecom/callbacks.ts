import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import { ACTION_APPROVE, ACTION_DENY, parseCallbackData, findSessionByPrefix } from './renderer'
import { buildSystemReplyCard, sessionUrl } from './sessionView'
import type { EventBody, UpdateTemplateCardBody, WsFrame } from './types'

export interface CallbackCtx {
    syncEngine: SyncEngine
    store: Store
    publicUrl: string
    sendUpdate: (payload: { reqId: string; body: UpdateTemplateCardBody }) => void
}

function findRequestByPrefix(session: Session, prefix: string): string | null {
    if (!prefix) return null
    const requests = session.agentState?.requests
    if (!requests) return null
    for (const id of Object.keys(requests)) {
        if (id.startsWith(prefix)) return id
    }
    return null
}

function reply(
    ctx: CallbackCtx,
    reqId: string,
    title: string,
    taskId?: string,
    sessionId?: string
): void {
    const url = sessionId ? sessionUrl(ctx.publicUrl, sessionId) : ctx.publicUrl
    const card = buildSystemReplyCard(title, url)
    // WeCom requires the update-card's template_card.task_id to match the
    // original card's task_id; otherwise the server silently discards the
    // response and the original card never gets replaced in the client.
    if (taskId) card.task_id = taskId
    ctx.sendUpdate({
        reqId,
        body: {
            response_type: 'update_template_card',
            template_card: card
        }
    })
}

export async function handleTemplateCardEvent(
    frame: WsFrame<EventBody>,
    ctx: CallbackCtx
): Promise<void> {
    const event = frame.body?.event
    if (!event || event.eventtype !== 'template_card_event') return
    const callbackReqId = frame.headers?.req_id
    if (!callbackReqId) return

    // WeCom's live wire format nests click details under `event.template_card_event`.
    // Fall back to flat fields on the event itself for older payloads.
    const details = event.template_card_event ?? {}
    const rawKey = details.event_key ?? event.event_key ?? ''
    const taskId = details.task_id ?? event.task_id

    const userid = frame.body?.from?.userid
    const parsed = parseCallbackData(rawKey)
    if (parsed.action !== ACTION_APPROVE && parsed.action !== ACTION_DENY) {
        return
    }

    if (!userid) {
        reply(ctx, callbackReqId, 'Not bound', taskId)
        return
    }

    const user = ctx.store.users.getUser('wecom', userid)
    if (!user) {
        reply(ctx, callbackReqId, 'Not bound', taskId)
        return
    }

    const sessions = ctx.syncEngine.getSessionsByNamespace(user.namespace)
    const session = findSessionByPrefix(sessions, parsed.sessionPrefix)
    if (!session) {
        reply(ctx, callbackReqId, 'Session not found', taskId)
        return
    }
    if (!session.active) {
        reply(ctx, callbackReqId, 'Session inactive', taskId, session.id)
        return
    }
    const requestId = findRequestByPrefix(session, parsed.extra ?? '')
    if (!requestId) {
        reply(ctx, callbackReqId, 'Already processed', taskId, session.id)
        return
    }

    try {
        if (parsed.action === ACTION_APPROVE) {
            await ctx.syncEngine.approvePermission(session.id, requestId)
            reply(ctx, callbackReqId, 'Permission approved.', taskId, session.id)
        } else {
            await ctx.syncEngine.denyPermission(session.id, requestId)
            reply(ctx, callbackReqId, 'Permission denied.', taskId, session.id)
        }
    } catch (err) {
        console.error('[WecomBot] callback failed:', err)
        reply(ctx, callbackReqId, 'An error occurred', taskId, session.id)
    }
}
