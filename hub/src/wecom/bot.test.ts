import { describe, expect, it, mock } from 'bun:test'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type { SendMsgBody, UpdateTemplateCardBody, WsFrame, TextMessageBody } from './types'
import { WecomBot } from './bot'

class FakeClient {
    onMessage: ((frame: WsFrame<TextMessageBody>) => void) | null = null
    onEvent: ((frame: unknown) => void) | null = null
    sent: Array<{ cmd: string; body: SendMsgBody | UpdateTemplateCardBody }> = []
    sentReqIds: Array<{ cmd: string; reqId: string; body: SendMsgBody | UpdateTemplateCardBody }> = []
    started = false
    stopped = false
    start() { this.started = true }
    stop() { this.stopped = true }
    send(cmd: string, body: SendMsgBody | UpdateTemplateCardBody) {
        this.sent.push({ cmd, body })
    }
    sendWithReqId(cmd: string, reqId: string, body: SendMsgBody | UpdateTemplateCardBody) {
        this.sentReqIds.push({ cmd, reqId, body })
    }
}

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'abcdef0123456789',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/tmp/proj', host: 'mac' },
        metadataVersion: 0,
        agentState: {
            requests: {
                'req98765432abc': { tool: 'Bash', arguments: { command: 'ls' } }
            }
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

function makeBot(bound: Array<{ platformUserId: string; namespace: string }> = [
    { platformUserId: 'wecom-user-1', namespace: 'default' }
]) {
    const addUser = mock((_platform: string, _uid: string, ns: string) => ({
        id: 1, platform: 'wecom', platformUserId: 'wecom-user-1', namespace: ns, createdAt: 0
    }))
    const store = {
        users: {
            getUsersByPlatformAndNamespace: (_p: string, ns: string) =>
                bound.filter((u) => u.namespace === ns).map((u) => ({
                    id: 1, platform: 'wecom', createdAt: 0, ...u
                })),
            getUser: (_p: string, uid: string) =>
                bound.find((u) => u.platformUserId === uid)
                    ? { id: 1, platform: 'wecom', platformUserId: uid, namespace: bound.find((u) => u.platformUserId === uid)!.namespace, createdAt: 0 }
                    : null,
            addUser
        }
    } as unknown as Store

    const syncEngine = {
        getSessionsByNamespace: (_ns: string) => [session()],
        approvePermission: mock(async () => {}),
        denyPermission: mock(async () => {})
    } as unknown as SyncEngine

    const client = new FakeClient()
    const bot = new WecomBot({
        botId: 'BOT',
        secret: 'SECRET',
        cliApiToken: 'TOKEN',
        publicUrl: 'https://hapi.example.com',
        store,
        syncEngine,
        client: client as unknown as import('./client').WecomWSClient
    })
    return { bot, client, store, syncEngine, addUser }
}

describe('WecomBot.start / stop', () => {
    it('starts and stops the underlying client', () => {
        const { bot, client } = makeBot()
        bot.start()
        expect(client.started).toBe(true)
        bot.stop()
        expect(client.stopped).toBe(true)
    })
})

describe('WecomBot.sendPermissionRequest', () => {
    it('sends a button_interaction card to every bound userid with Allow/Deny keys', async () => {
        const { bot, client } = makeBot([
            { platformUserId: 'u1', namespace: 'default' },
            { platformUserId: 'u2', namespace: 'default' }
        ])
        await bot.sendPermissionRequest(session())

        expect(client.sent).toHaveLength(2)
        for (const sent of client.sent) {
            expect(sent.cmd).toBe('aibot_send_msg')
            const body = sent.body as Extract<SendMsgBody, { msgtype: 'template_card' }>
            expect(body.msgtype).toBe('template_card')
            expect(body.template_card.card_type).toBe('button_interaction')
            expect(body.template_card.button_list?.[0].key).toBe('ap:abcdef01:req98765')
            expect(body.template_card.button_list?.[1].key).toBe('dn:abcdef01:req98765')
        }
        expect((client.sent[0].body as SendMsgBody).chatid).toBe('u1')
        expect((client.sent[1].body as SendMsgBody).chatid).toBe('u2')
    })

    it('no-ops when the session has no bound WeCom users', async () => {
        const { bot, client } = makeBot([])
        await bot.sendPermissionRequest(session())
        expect(client.sent).toHaveLength(0)
    })

    it('no-ops when the session is inactive', async () => {
        const { bot, client } = makeBot()
        await bot.sendPermissionRequest(session({ active: false }))
        expect(client.sent).toHaveLength(0)
    })
})

describe('WecomBot.sendReady', () => {
    it('sends a text_notice card to each bound user', async () => {
        const { bot, client } = makeBot()
        await bot.sendReady(session())
        expect(client.sent).toHaveLength(1)
        const body = client.sent[0].body as Extract<SendMsgBody, { msgtype: 'template_card' }>
        expect(body.template_card.main_title?.title).toBe('Ready for input')
    })
})

describe('WecomBot.sendTaskNotification', () => {
    it('sends task notifications only for failure statuses', async () => {
        const { bot, client } = makeBot()
        await bot.sendTaskNotification(session(), { status: 'completed', summary: 's' })
        expect(client.sent).toHaveLength(0)
        await bot.sendTaskNotification(session(), { status: 'failed', summary: 's' })
        expect(client.sent).toHaveLength(1)
        const body = client.sent[0].body as Extract<SendMsgBody, { msgtype: 'template_card' }>
        expect(body.template_card.main_title?.title).toBe('Task failed')
    })
})

describe('WecomBot binding', () => {
    it('binds a user when they send "<token>:<namespace>"', () => {
        const { bot, client, addUser } = makeBot([])
        client.onMessage!({
            cmd: 'aibot_msg_callback',
            headers: { req_id: 'r1' },
            body: {
                msgid: 'm', aibotid: 'b', chattype: 'single',
                from: { userid: 'u-new' },
                msgtype: 'text',
                text: { content: 'TOKEN:myns' }
            }
        })
        expect(addUser).toHaveBeenCalledWith('wecom', 'u-new', 'myns')
        expect(client.sent).toHaveLength(1)
        const body = client.sent[0].body as Extract<SendMsgBody, { msgtype: 'markdown' }>
        expect(body.msgtype).toBe('markdown')
        expect(body.markdown.content).toContain('myns')
    })

    it('ignores non-matching text content', () => {
        const { bot, client, addUser } = makeBot([])
        client.onMessage!({
            cmd: 'aibot_msg_callback',
            headers: { req_id: 'r1' },
            body: {
                msgid: 'm', aibotid: 'b', chattype: 'single',
                from: { userid: 'u-new' },
                msgtype: 'text',
                text: { content: 'hello' }
            }
        })
        expect(addUser).not.toHaveBeenCalled()
        expect(client.sent).toHaveLength(0)
    })
})

describe('WecomBot onEvent (template card click)', () => {
    it('dispatches approve and replies via sendWithReqId using the callback req_id', async () => {
        const { bot, client, syncEngine } = makeBot()
        void bot
        client.onEvent!({
            cmd: 'aibot_event_callback',
            headers: { req_id: 'cb-42' },
            body: {
                msgid: 'm', aibotid: 'b',
                from: { userid: 'wecom-user-1' },
                msgtype: 'event',
                event: { eventtype: 'template_card_event', event_key: 'ap:abcdef01:req98765', task_id: 't' }
            }
        })
        await new Promise((r) => setTimeout(r, 0))

        expect((syncEngine.approvePermission as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1)
        expect(client.sentReqIds).toHaveLength(1)
        expect(client.sentReqIds[0].cmd).toBe('aibot_respond_update_msg')
        expect(client.sentReqIds[0].reqId).toBe('cb-42')
    })

    it('denies and replies with the callback req_id', async () => {
        const { bot, client, syncEngine } = makeBot()
        void bot
        client.onEvent!({
            cmd: 'aibot_event_callback',
            headers: { req_id: 'cb-43' },
            body: {
                msgid: 'm', aibotid: 'b',
                from: { userid: 'wecom-user-1' },
                msgtype: 'event',
                event: { eventtype: 'template_card_event', event_key: 'dn:abcdef01:req98765', task_id: 't' }
            }
        })
        await new Promise((r) => setTimeout(r, 0))
        expect((syncEngine.denyPermission as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1)
        expect(client.sentReqIds[0].reqId).toBe('cb-43')
    })
})
