import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import { ACTION_APPROVE, ACTION_DENY, parseCallbackData, findSessionByPrefix } from './renderer'
import { buildSystemReplyCard } from './sessionView'
import type { EventBody, UpdateTemplateCardBody, WsFrame } from './types'

export interface CallbackCtx {
    syncEngine: SyncEngine
    store: Store
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

function reply(ctx: CallbackCtx, reqId: string, title: string): void {
    ctx.sendUpdate({
        reqId,
        body: {
            response_type: 'update_template_card',
            template_card: buildSystemReplyCard(title)
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

    const userid = frame.body?.from?.userid
    const parsed = parseCallbackData(event.event_key ?? '')
    if (parsed.action !== ACTION_APPROVE && parsed.action !== ACTION_DENY) {
        return
    }

    if (!userid) {
        reply(ctx, callbackReqId, 'Not bound')
        return
    }

    const user = ctx.store.users.getUser('wecom', userid)
    if (!user) {
        reply(ctx, callbackReqId, 'Not bound')
        return
    }

    const sessions = ctx.syncEngine.getSessionsByNamespace(user.namespace)
    const session = findSessionByPrefix(sessions, parsed.sessionPrefix)
    if (!session) {
        reply(ctx, callbackReqId, 'Session not found')
        return
    }
    if (!session.active) {
        reply(ctx, callbackReqId, 'Session inactive')
        return
    }
    const requestId = findRequestByPrefix(session, parsed.extra ?? '')
    if (!requestId) {
        reply(ctx, callbackReqId, 'Already processed')
        return
    }

    try {
        if (parsed.action === ACTION_APPROVE) {
            await ctx.syncEngine.approvePermission(session.id, requestId)
            reply(ctx, callbackReqId, 'Permission approved.')
        } else {
            await ctx.syncEngine.denyPermission(session.id, requestId)
            reply(ctx, callbackReqId, 'Permission denied.')
        }
    } catch (err) {
        console.error('[WecomBot] callback failed:', err)
        reply(ctx, callbackReqId, 'An error occurred')
    }
}
