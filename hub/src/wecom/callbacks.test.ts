import { describe, expect, it, mock } from 'bun:test'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type { WsFrame, EventBody } from './types'
import { handleTemplateCardEvent } from './callbacks'

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'abcdef0123456789',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: {
            requests: { 'req98765432abc': { tool: 'Bash', arguments: { command: 'ls' } } }
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    } as Session
}

function makeFrame(event_key: string, userid = 'u-1'): WsFrame<EventBody> {
    return {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'callback-req-1' },
        body: {
            msgid: 'm1',
            aibotid: 'bot',
            from: { userid },
            msgtype: 'event',
            event: { eventtype: 'template_card_event', event_key, task_id: 't' }
        }
    }
}

function makeCtx(opts: {
    session?: Session | null
    userNamespace?: string | null
    approve?: () => Promise<void>
    deny?: () => Promise<void>
} = {}) {
    const sendUpdate = mock((_body: unknown) => {})
    const approve = opts.approve ?? (async () => {})
    const deny = opts.deny ?? (async () => {})

    const syncEngine = {
        getSessionsByNamespace: () => (opts.session ? [opts.session] : []),
        approvePermission: approve,
        denyPermission: deny
    } as unknown as SyncEngine

    const store = {
        users: {
            getUser: (_platform: string, _uid: string) =>
                opts.userNamespace ? { platform: 'wecom', platformUserId: 'u-1', namespace: opts.userNamespace } : null
        }
    } as unknown as Store

    return {
        syncEngine,
        store,
        sendUpdate,
        publicUrl: 'https://hapi.example.com'
    }
}

describe('handleTemplateCardEvent', () => {
    it('approves and sends an "approved" update card for the callback req_id', async () => {
        const approve = mock(async () => {})
        const ctx = makeCtx({ session: makeSession(), userNamespace: 'default', approve })
        const frame = makeFrame('ap:abcdef01:req98765')

        await handleTemplateCardEvent(frame, ctx)

        expect(approve).toHaveBeenCalledWith('abcdef0123456789', 'req98765432abc')
        expect(ctx.sendUpdate).toHaveBeenCalledTimes(1)
        const [arg] = ctx.sendUpdate.mock.calls[0] as [{ reqId: string; body: { response_type: string; template_card: { main_title?: { title?: string } } } }]
        expect(arg.reqId).toBe('callback-req-1')
        expect(arg.body.response_type).toBe('update_template_card')
        expect(arg.body.template_card.main_title?.title).toBe('Permission approved.')
    })

    it('denies and sends a "denied" update card', async () => {
        const deny = mock(async () => {})
        const ctx = makeCtx({ session: makeSession(), userNamespace: 'default', deny })
        const frame = makeFrame('dn:abcdef01:req98765')

        await handleTemplateCardEvent(frame, ctx)

        expect(deny).toHaveBeenCalledWith('abcdef0123456789', 'req98765432abc')
        const [arg] = ctx.sendUpdate.mock.calls[0] as [{ body: { template_card: { main_title?: { title?: string } } } }]
        expect(arg.body.template_card.main_title?.title).toBe('Permission denied.')
    })

    it('replies with "Not bound" when the userid has no binding', async () => {
        const ctx = makeCtx({ userNamespace: null })
        await handleTemplateCardEvent(makeFrame('ap:abcdef01:req98765'), ctx)
        const [arg] = ctx.sendUpdate.mock.calls[0] as [{ body: { template_card: { main_title?: { title?: string } } } }]
        expect(arg.body.template_card.main_title?.title).toBe('Not bound')
    })

    it('replies with "Session inactive" when the session is inactive', async () => {
        const ctx = makeCtx({
            session: makeSession({ active: false }),
            userNamespace: 'default'
        })
        await handleTemplateCardEvent(makeFrame('ap:abcdef01:req98765'), ctx)
        const [arg] = ctx.sendUpdate.mock.calls[0] as [{ body: { template_card: { main_title?: { title?: string } } } }]
        expect(arg.body.template_card.main_title?.title).toBe('Session inactive')
    })

    it('replies with "Already processed" when the request is gone', async () => {
        const ctx = makeCtx({
            session: makeSession({ agentState: { requests: {} } }),
            userNamespace: 'default'
        })
        await handleTemplateCardEvent(makeFrame('ap:abcdef01:req98765'), ctx)
        const [arg] = ctx.sendUpdate.mock.calls[0] as [{ body: { template_card: { main_title?: { title?: string } } } }]
        expect(arg.body.template_card.main_title?.title).toBe('Already processed')
    })

    it('ignores unknown actions', async () => {
        const ctx = makeCtx({ session: makeSession(), userNamespace: 'default' })
        await handleTemplateCardEvent(makeFrame('xx:abcdef01:req98765'), ctx)
        expect(ctx.sendUpdate).not.toHaveBeenCalled()
    })
})
