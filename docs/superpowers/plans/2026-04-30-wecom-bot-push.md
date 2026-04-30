# WeCom Bot WebSocket Push Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WeCom (企业微信) smart-robot WebSocket long-connection channel to the hub. Permission-request notifications ship as `button_interaction` template cards; clicking Allow/Deny runs approve/deny through `SyncEngine` and updates the card via `aibot_respond_update_msg`. Ready, task, and session-completion notifications ship as `text_notice` cards.

**Architecture:** New `hub/src/wecom/` module implementing the existing `NotificationChannel` interface — one long-lived `WebSocket` (Bun native) per hub process, auth via `aibot_subscribe`, 30 s `ping` heartbeat, exponential-backoff reconnect. Callback keys encode `action:sessionPrefix:requestPrefix` (mirrors `hub/src/telegram/renderer.ts`). Users bind a WeCom userid to a hapi namespace by sending `<CLI_API_TOKEN>:<namespace>` in single chat; mapping is persisted to the existing `users` table with `platform='wecom'`.

**Tech Stack:** TypeScript (strict), Bun runtime, Bun's built-in `WebSocket` client, Zod (existing), `bun:test`, `bun:sqlite`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-30-wecom-bot-push-design.md`

---

## File structure

### New files

| File | Responsibility |
|------|----------------|
| `hub/src/wecom/types.ts` | Shared WeCom frame / template-card TypeScript types. |
| `hub/src/wecom/renderer.ts` | Callback-key codec + session/request prefix lookup helpers. |
| `hub/src/wecom/renderer.test.ts` | Unit tests for codec + helpers. |
| `hub/src/wecom/sessionView.ts` | Template-card builders (permission / ready / task / session-completion / system-reply). |
| `hub/src/wecom/sessionView.test.ts` | Unit tests for the interactive permission card shape. |
| `hub/src/wecom/client.ts` | `WecomWSClient` — WebSocket state machine, subscribe, heartbeat, reconnect, send API. |
| `hub/src/wecom/callbacks.ts` | `handleCallback(frame, ctx)` — `template_card_event` → approve/deny → update card. |
| `hub/src/wecom/callbacks.test.ts` | Unit tests for the callback handler. |
| `hub/src/wecom/bot.ts` | `WecomBot` — `NotificationChannel` impl, binding handler, wiring of client + callbacks. |
| `hub/src/wecom/bot.test.ts` | Unit tests for push frames + text-bind handling. |

### Modified files

| File | Change |
|------|--------|
| `hub/src/config/settings.ts` | Add three optional `Settings` fields: `wecomBotId`, `wecomBotSecret`, `wecomNotification`. |
| `hub/src/config/serverSettings.ts` | Load + persist those fields following the existing ServerChan block pattern. |
| `hub/src/configuration.ts` | Expose `wecomBotId`, `wecomBotSecret`, `wecomEnabled`, `wecomNotification` + source tracking. |
| `hub/src/index.ts` | Startup log lines + conditional `WecomBot` construction, start, and shutdown hook. |
| `hub/README.md` | Document the new env vars in the "Optional" section. |

No schema migration required (the `users` table already has a `platform` column).

---

## Task 1: Config layer — settings + loader + Configuration + startup logs

Adds the three WeCom config fields end-to-end. No behaviour yet — downstream tasks depend on the Configuration shape.

**Files:**
- Modify: `hub/src/config/settings.ts`
- Modify: `hub/src/config/serverSettings.ts`
- Modify: `hub/src/configuration.ts`
- Modify: `hub/src/index.ts` (startup banner only)

### Steps

- [ ] **Step 1: Add the three fields to the `Settings` type**

Edit `hub/src/config/settings.ts`, inside the existing `Settings` interface, add after the ServerChan lines:

```ts
    wecomBotId?: string
    wecomBotSecret?: string
    wecomNotification?: boolean
```

Exact position: right after `serverChanNotification?: boolean` (around line 18).

- [ ] **Step 2: Extend `ServerSettings` + `ServerSettingsResult` in the loader**

Edit `hub/src/config/serverSettings.ts`. Inside the `ServerSettings` interface add after the ServerChan fields:

```ts
    wecomBotId: string | null
    wecomBotSecret: string | null
    wecomNotification: boolean
```

Inside the `ServerSettingsResult.sources` type, add three matching keys:

```ts
        wecomBotId: 'env' | 'file' | 'default'
        wecomBotSecret: 'env' | 'file' | 'default'
        wecomNotification: 'env' | 'file' | 'default'
```

- [ ] **Step 3: Load the three fields in `loadServerSettings`**

In the same file, inside the `sources` literal initializer, add:

```ts
        wecomBotId: 'default',
        wecomBotSecret: 'default',
        wecomNotification: 'default',
```

Then, right after the existing ServerChan loading block (after the `serverChanNotification` block, before `listenHost`), insert:

```ts
    // wecomBotId: env > file > null
    let wecomBotId: string | null = null
    if (process.env.WECOM_BOT_ID) {
        wecomBotId = process.env.WECOM_BOT_ID
        sources.wecomBotId = 'env'
        if (settings.wecomBotId === undefined) {
            settings.wecomBotId = wecomBotId
            needsSave = true
        }
    } else if (settings.wecomBotId !== undefined) {
        wecomBotId = settings.wecomBotId
        sources.wecomBotId = 'file'
    }

    // wecomBotSecret: env > file > null
    let wecomBotSecret: string | null = null
    if (process.env.WECOM_BOT_SECRET) {
        wecomBotSecret = process.env.WECOM_BOT_SECRET
        sources.wecomBotSecret = 'env'
        if (settings.wecomBotSecret === undefined) {
            settings.wecomBotSecret = wecomBotSecret
            needsSave = true
        }
    } else if (settings.wecomBotSecret !== undefined) {
        wecomBotSecret = settings.wecomBotSecret
        sources.wecomBotSecret = 'file'
    }

    // wecomNotification: env > file > true
    let wecomNotification = true
    if (process.env.WECOM_NOTIFICATION !== undefined) {
        wecomNotification = process.env.WECOM_NOTIFICATION === 'true'
        sources.wecomNotification = 'env'
        if (settings.wecomNotification === undefined) {
            settings.wecomNotification = wecomNotification
            needsSave = true
        }
    } else if (settings.wecomNotification !== undefined) {
        wecomNotification = settings.wecomNotification
        sources.wecomNotification = 'file'
    }
```

Then, in the returned object's `settings` block, after `serverChanNotification`, add:

```ts
            wecomBotId,
            wecomBotSecret,
            wecomNotification,
```

- [ ] **Step 4: Expose the fields on `Configuration`**

Edit `hub/src/configuration.ts`. Inside the top-level env-var comment block, after the `SERVERCHAN_NOTIFICATION` line, add:

```
 * - WECOM_BOT_ID: WeCom smart robot BotID (long-connection mode)
 * - WECOM_BOT_SECRET: WeCom smart robot long-connection Secret
 * - WECOM_NOTIFICATION: Enable/disable WeCom notifications (default: true)
```

Inside the `ConfigSources` interface, add:

```ts
    wecomBotId: ConfigSource
    wecomBotSecret: ConfigSource
    wecomNotification: ConfigSource
```

Inside the `Configuration` class, after the ServerChan block, add:

```ts
    /** WeCom Bot ID */
    public readonly wecomBotId: string | null

    /** WeCom Bot Secret */
    public readonly wecomBotSecret: string | null

    /** WeCom bot enabled status (both ID and Secret present) */
    public readonly wecomEnabled: boolean

    /** WeCom notifications enabled */
    public readonly wecomNotification: boolean
```

Inside the private constructor, after `this.serverChanNotification = serverSettings.serverChanNotification`, add:

```ts
        this.wecomBotId = serverSettings.wecomBotId
        this.wecomBotSecret = serverSettings.wecomBotSecret
        this.wecomEnabled = Boolean(this.wecomBotId && this.wecomBotSecret)
        this.wecomNotification = serverSettings.wecomNotification
```

- [ ] **Step 5: Add startup log lines**

Edit `hub/src/index.ts`. After the ServerChan log block (after `console.log('[Hub] ServerChan: disabled (no SERVERCHAN_SENDKEY)')`), insert:

```ts
    if (config.wecomEnabled) {
        const source = formatSource(config.sources.wecomBotId)
        const notificationSource = formatSource(config.sources.wecomNotification)
        console.log(`[Hub] WeCom: enabled (${source})`)
        console.log(`[Hub] WeCom notifications: ${config.wecomNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    } else {
        console.log('[Hub] WeCom: disabled (no WECOM_BOT_ID/WECOM_BOT_SECRET)')
    }
```

- [ ] **Step 6: Typecheck**

Run: `bun typecheck`
Expected: no errors across all workspaces.

- [ ] **Step 7: Commit**

```bash
git add hub/src/config/settings.ts hub/src/config/serverSettings.ts hub/src/configuration.ts hub/src/index.ts
git commit -m "feat(hub): add WeCom bot config fields (wecomBotId/Secret/Notification)"
```

---

## Task 2: Callback-key codec (renderer.ts) — test-first

Matches the Telegram codec semantics so the callback shape is familiar. WeCom's button `key` limit is 1024 bytes, so the Telegram-style 8-char prefixes leave lots of headroom.

**Files:**
- Create: `hub/src/wecom/renderer.ts`
- Create: `hub/src/wecom/renderer.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests**

Create `hub/src/wecom/renderer.test.ts` with:

```ts
import { describe, expect, it } from 'bun:test'
import { createCallbackData, parseCallbackData, findSessionByPrefix } from './renderer'
import type { Session } from '../sync/syncEngine'

function session(id: string, overrides: Partial<Session> = {}): Session {
    return {
        id,
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    }
}

describe('createCallbackData / parseCallbackData', () => {
    it('encodes action + session prefix + extra using 8-char session prefix', () => {
        const data = createCallbackData('ap', 'abcdef0123456789', 'req98765432')
        expect(data).toBe('ap:abcdef01:req98765432')
    })

    it('round-trips via parseCallbackData', () => {
        const data = createCallbackData('dn', 'sessionidabc', 'requestidxyz')
        expect(parseCallbackData(data)).toEqual({
            action: 'dn',
            sessionPrefix: 'sessionid',
            extra: 'requestidxyz'
        })
    })

    it('omits extra segment when not provided', () => {
        const data = createCallbackData('ap', 'sessid12xyz')
        expect(data).toBe('ap:sessid12')
        expect(parseCallbackData(data)).toEqual({
            action: 'ap',
            sessionPrefix: 'sessid12',
            extra: undefined
        })
    })
})

describe('findSessionByPrefix', () => {
    it('returns the first session whose id starts with the prefix', () => {
        const a = session('abcd1234-aaaa')
        const b = session('abcd5678-bbbb')
        expect(findSessionByPrefix([a, b], 'abcd5678')).toBe(b)
    })

    it('returns undefined when no session matches', () => {
        expect(findSessionByPrefix([session('zzzz')], 'aaaa')).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hub && bun test src/wecom/renderer.test.ts`
Expected: FAIL — `Cannot find module './renderer'`.

- [ ] **Step 3: Implement `renderer.ts`**

Create `hub/src/wecom/renderer.ts`:

```ts
import type { Session } from '../sync/syncEngine'

const SESSION_PREFIX_LEN = 8

export function createCallbackData(action: string, sessionId: string, extra?: string): string {
    const sessionPrefix = sessionId.slice(0, SESSION_PREFIX_LEN)
    let data = `${action}:${sessionPrefix}`
    if (extra) {
        data += `:${extra}`
    }
    return data
}

export function parseCallbackData(data: string): {
    action: string
    sessionPrefix: string
    extra?: string
} {
    const parts = data.split(':')
    return {
        action: parts[0] || '',
        sessionPrefix: parts[1] || '',
        extra: parts[2]
    }
}

export function findSessionByPrefix(sessions: Session[], prefix: string): Session | undefined {
    return sessions.find((session) => session.id.startsWith(prefix))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hub && bun test src/wecom/renderer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/src/wecom/renderer.ts hub/src/wecom/renderer.test.ts
git commit -m "feat(hub/wecom): add callback-data codec + session prefix lookup"
```

---

## Task 3: Protocol types (types.ts) — pure type file, no tests

Centralizes the WeCom frame shapes used by `client.ts`, `callbacks.ts`, and `bot.ts`. Defining them once keeps later steps small.

**Files:**
- Create: `hub/src/wecom/types.ts`

### Steps

- [ ] **Step 1: Create `types.ts`**

```ts
/**
 * WeCom aibot WebSocket protocol types.
 *
 * Only the subset the hub uses. See the design spec for the full protocol:
 * docs/superpowers/specs/2026-04-30-wecom-bot-push-design.md
 */

export const WS_URL = 'wss://openws.work.weixin.qq.com'

export const WsCmd = {
    SUBSCRIBE: 'aibot_subscribe',
    HEARTBEAT: 'ping',
    SEND_MSG: 'aibot_send_msg',
    RESPONSE_UPDATE: 'aibot_respond_update_msg',
    MSG_CALLBACK: 'aibot_msg_callback',
    EVENT_CALLBACK: 'aibot_event_callback'
} as const

export type WsCmdValue = (typeof WsCmd)[keyof typeof WsCmd]

export interface WsFrame<T = unknown> {
    cmd?: string
    headers: { req_id: string; [key: string]: unknown }
    body?: T
    errcode?: number
    errmsg?: string
}

// --- Inbound: aibot_msg_callback (text) ---

export interface TextMessageBody {
    msgid: string
    aibotid: string
    chatid?: string
    chattype: 'single' | 'group'
    from: { userid: string }
    msgtype: 'text'
    text: { content: string }
    [key: string]: unknown
}

// --- Inbound: aibot_event_callback ---

export interface TemplateCardEvent {
    eventtype: 'template_card_event'
    event_key?: string
    task_id?: string
}

export interface EnterChatEvent { eventtype: 'enter_chat' }
export interface FeedbackEvent { eventtype: 'feedback_event' }
export interface DisconnectedEvent { eventtype: 'disconnected_event' }

export type EventContent =
    | TemplateCardEvent
    | EnterChatEvent
    | FeedbackEvent
    | DisconnectedEvent

export interface EventBody {
    msgid: string
    aibotid: string
    chatid?: string
    chattype?: 'single' | 'group'
    from: { userid: string; corpid?: string }
    msgtype: 'event'
    event: EventContent
    create_time?: number
    [key: string]: unknown
}

// --- Outbound: template card ---

export interface TemplateCardButton {
    text: string
    /** 1..4 (button style). 1 = default, 2 = highlighted (used for Deny in this repo). */
    style?: number
    key: string
}

export interface TemplateCardMainTitle {
    title?: string
    desc?: string
}

export interface TemplateCardAction {
    type: 0 | 1 | 2
    url?: string
    appid?: string
    pagepath?: string
}

export interface TemplateCard {
    card_type:
        | 'text_notice'
        | 'news_notice'
        | 'button_interaction'
        | 'vote_interaction'
        | 'multiple_interaction'
    main_title?: TemplateCardMainTitle
    sub_title_text?: string
    button_list?: TemplateCardButton[]
    card_action?: TemplateCardAction
    task_id?: string
}

// --- Outbound: aibot_send_msg bodies ---

export interface SendTemplateCardBody {
    chatid: string
    msgtype: 'template_card'
    template_card: TemplateCard
}

export interface SendMarkdownBody {
    chatid: string
    msgtype: 'markdown'
    markdown: { content: string }
}

export type SendMsgBody = SendTemplateCardBody | SendMarkdownBody

// --- Outbound: aibot_respond_update_msg body ---

export interface UpdateTemplateCardBody {
    response_type: 'update_template_card'
    userids?: string[]
    template_card: TemplateCard
}

// --- Outbound: aibot_subscribe body ---

export interface SubscribeBody {
    bot_id: string
    secret: string
}
```

- [ ] **Step 2: Typecheck**

Run: `bun typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/wecom/types.ts
git commit -m "feat(hub/wecom): add WeCom aibot protocol types"
```

---

## Task 4: Template-card builders (sessionView.ts) — test the interactive card

The builder functions are mostly data mapping. Only the button-interaction card needs tests (the `key` encoding is load-bearing for the callback path).

**Files:**
- Create: `hub/src/wecom/sessionView.ts`
- Create: `hub/src/wecom/sessionView.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests**

Create `hub/src/wecom/sessionView.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import {
    buildPermissionCard,
    buildReadyCard,
    buildTaskCard,
    buildSessionCompletionCard,
    buildSystemReplyCard
} from './sessionView'

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
                'req98765432abcdef': {
                    tool: 'Bash',
                    arguments: { command: 'ls -la' }
                }
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

describe('buildPermissionCard', () => {
    it('returns a button_interaction card with Allow / Deny keyed on session+request prefixes', () => {
        const card = buildPermissionCard(session(), 'https://hapi.example.com')
        expect(card.card_type).toBe('button_interaction')
        expect(card.main_title?.title).toBe('Permission Request')
        expect(card.button_list).toHaveLength(2)
        expect(card.button_list![0]).toEqual({
            text: 'Allow',
            style: 1,
            key: 'ap:abcdef01:req98765'
        })
        expect(card.button_list![1]).toEqual({
            text: 'Deny',
            style: 2,
            key: 'dn:abcdef01:req98765'
        })
        expect(card.task_id).toMatch(/^hapi-abcdef01-req98765-\d+$/)
    })

    it('returns null when there are no pending requests', () => {
        const card = buildPermissionCard(session({ agentState: null }), 'https://hapi.example.com')
        expect(card).toBeNull()
    })
})

describe('buildReadyCard', () => {
    it('returns a text_notice card with a session URL action', () => {
        const card = buildReadyCard(session(), 'https://hapi.example.com')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Ready for input')
        expect(card.card_action).toEqual({
            type: 1,
            url: 'https://hapi.example.com/sessions/abcdef0123456789'
        })
    })
})

describe('buildTaskCard', () => {
    it('marks failed tasks with a failure title', () => {
        const card = buildTaskCard(session(), { status: 'failed', summary: 'Boom' }, 'https://hapi.example.com')
        expect(card.main_title?.title).toBe('Task failed')
    })

    it('marks completed tasks with a success title', () => {
        const card = buildTaskCard(session(), { status: 'completed', summary: 'Done' }, 'https://hapi.example.com')
        expect(card.main_title?.title).toBe('Task completed')
    })
})

describe('buildSessionCompletionCard', () => {
    it('returns a text_notice card', () => {
        const card = buildSessionCompletionCard(session(), 'https://hapi.example.com')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Session completed')
    })
})

describe('buildSystemReplyCard', () => {
    it('builds a simple notice card with the given title', () => {
        const card = buildSystemReplyCard('Permission approved.')
        expect(card.card_type).toBe('text_notice')
        expect(card.main_title?.title).toBe('Permission approved.')
        expect(card.button_list).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hub && bun test src/wecom/sessionView.test.ts`
Expected: FAIL — `Cannot find module './sessionView'`.

- [ ] **Step 3: Implement `sessionView.ts`**

Create `hub/src/wecom/sessionView.ts`:

```ts
import type { Session } from '../sync/syncEngine'
import type { TaskNotification } from '../notifications/notificationTypes'
import type { AgentStateRequest } from '@hapi/protocol/types'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { createCallbackData } from './renderer'
import type { TemplateCard } from './types'

const ACTION_APPROVE = 'ap'
const ACTION_DENY = 'dn'
const MAX_ARGS_LEN = 200

function sessionUrl(publicUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, publicUrl).toString()
    } catch {
        const normalized = publicUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

function truncate(value: string, max: number): string {
    if (value.length <= max) return value
    return value.slice(0, max - 3) + '...'
}

function formatArgs(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') return ''
    const obj = args as Record<string, unknown>
    switch (tool) {
        case 'Bash':
            return typeof obj.command === 'string' ? `Command: ${truncate(obj.command, MAX_ARGS_LEN)}` : ''
        case 'Edit':
        case 'Write':
        case 'Read': {
            const file = obj.file_path ?? obj.path
            return typeof file === 'string' ? `File: ${truncate(file, MAX_ARGS_LEN)}` : ''
        }
        default:
            try {
                return `Args: ${truncate(JSON.stringify(args), MAX_ARGS_LEN)}`
            } catch {
                return ''
            }
    }
}

export function buildPermissionCard(session: Session, publicUrl: string): TemplateCard | null {
    const requests = session.agentState?.requests
    if (!requests) return null
    const requestId = Object.keys(requests)[0]
    if (!requestId) return null
    const request = requests[requestId] as AgentStateRequest

    const sidPrefix = session.id.slice(0, 8)
    const reqPrefix = requestId.slice(0, 8)
    const name = getSessionName(session)
    const argsLine = formatArgs(request.tool, request.arguments)

    const card: TemplateCard = {
        card_type: 'button_interaction',
        main_title: { title: 'Permission Request', desc: name },
        sub_title_text: argsLine
            ? `Tool: ${request.tool}\n${argsLine}`
            : `Tool: ${request.tool}`,
        button_list: [
            { text: 'Allow', style: 1, key: createCallbackData(ACTION_APPROVE, session.id, reqPrefix) },
            { text: 'Deny', style: 2, key: createCallbackData(ACTION_DENY, session.id, reqPrefix) }
        ],
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) },
        task_id: `hapi-${sidPrefix}-${reqPrefix}-${Date.now()}`
    }
    return card
}

export function buildReadyCard(session: Session, publicUrl: string): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    return {
        card_type: 'text_notice',
        main_title: { title: 'Ready for input', desc: `${agent} · ${name}` },
        sub_title_text: `${agent} is waiting for your command`,
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildTaskCard(
    session: Session,
    notification: TaskNotification,
    publicUrl: string
): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    const status = notification.status?.trim().toLowerCase()
    const failed = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
    return {
        card_type: 'text_notice',
        main_title: {
            title: failed ? 'Task failed' : 'Task completed',
            desc: `${agent} · ${name}`
        },
        sub_title_text: truncate(notification.summary, 300),
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildSessionCompletionCard(session: Session, publicUrl: string): TemplateCard {
    const agent = getAgentName(session)
    const name = getSessionName(session)
    return {
        card_type: 'text_notice',
        main_title: { title: 'Session completed', desc: `${agent} · ${name}` },
        card_action: { type: 1, url: sessionUrl(publicUrl, session.id) }
    }
}

export function buildSystemReplyCard(title: string, desc?: string): TemplateCard {
    return {
        card_type: 'text_notice',
        main_title: { title, desc }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hub && bun test src/wecom/sessionView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/wecom/sessionView.ts hub/src/wecom/sessionView.test.ts
git commit -m "feat(hub/wecom): add template-card builders for permission/ready/task/session"
```

---

## Task 5: WebSocket client (client.ts) — connection, subscribe, heartbeat, reconnect

`WecomWSClient` is the hardest part. It is designed to be stubbable: it accepts a `WebSocketConstructor` option so `bot.ts` tests can pass a fake and the WS layer itself is not unit-tested (the spec's testing strategy lives at the `bot.ts` + `callbacks.ts` layer). The client exposes a small surface: `start()`, `stop()`, `send(cmd, body)`, and two event hooks (`onMessage`, `onEvent`) — enough for the bot to act on inbound frames without touching WS internals.

**Files:**
- Create: `hub/src/wecom/client.ts`

### Steps

- [ ] **Step 1: Implement `client.ts`**

```ts
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
        let frame: WsFrame
        try {
            frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
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
```

- [ ] **Step 2: Typecheck**

Run: `bun typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add hub/src/wecom/client.ts
git commit -m "feat(hub/wecom): add WebSocket client with subscribe/heartbeat/reconnect"
```

---

## Task 6: Callback handler (callbacks.ts) — test-first

Handles `template_card_event`: resolves namespace from userid, looks up the session + request by prefix, runs approve/deny, and replies with an update card reusing the callback frame's `req_id`.

**Files:**
- Create: `hub/src/wecom/callbacks.ts`
- Create: `hub/src/wecom/callbacks.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests**

Create `hub/src/wecom/callbacks.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hub && bun test src/wecom/callbacks.test.ts`
Expected: FAIL — `Cannot find module './callbacks'`.

- [ ] **Step 3: Implement `callbacks.ts`**

Create `hub/src/wecom/callbacks.ts`:

```ts
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import { parseCallbackData, findSessionByPrefix } from './renderer'
import { buildSystemReplyCard } from './sessionView'
import type { EventBody, UpdateTemplateCardBody, WsFrame } from './types'

const ACTION_APPROVE = 'ap'
const ACTION_DENY = 'dn'

export interface CallbackCtx {
    syncEngine: SyncEngine
    store: Store
    publicUrl: string
    sendUpdate: (payload: { reqId: string; body: UpdateTemplateCardBody }) => void
}

function findRequestByPrefix(session: Session, prefix: string): string | null {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hub && bun test src/wecom/callbacks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add hub/src/wecom/callbacks.ts hub/src/wecom/callbacks.test.ts
git commit -m "feat(hub/wecom): add template_card_event callback handler (approve/deny + update)"
```

---

## Task 7: WecomBot (bot.ts) — NotificationChannel + binding — test-first

Glues the client, renderer, callbacks, and sessionView together. Implements the `NotificationChannel` interface so it can be dropped into `NotificationHub`.

**Files:**
- Create: `hub/src/wecom/bot.ts`
- Create: `hub/src/wecom/bot.test.ts`

### Steps

- [ ] **Step 1: Write the failing tests**

Create `hub/src/wecom/bot.test.ts`:

```ts
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
        expect(client.sent[0].body.chatid).toBe('u1')
        expect(client.sent[1].body.chatid).toBe('u2')
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
        // ensure the bot is alive so client handlers are wired
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
        // Give the promise chain a tick to settle
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hub && bun test src/wecom/bot.test.ts`
Expected: FAIL — `Cannot find module './bot'`.

- [ ] **Step 3: Implement `bot.ts`**

Create `hub/src/wecom/bot.ts`:

```ts
import type { SessionEndReason } from '@hapi/protocol'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type {
    NotificationChannel,
    TaskNotification
} from '../notifications/notificationTypes'
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
        const status = notification.status?.trim().toLowerCase()
        const failed = status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
        // Mirror ServerChan: only send for failures to avoid notification noise.
        if (!failed) return
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

        const callbackReqId = frame.headers.req_id
        const ctx: CallbackCtx = {
            syncEngine: this.syncEngine,
            store: this.store,
            publicUrl: this.publicUrl,
            sendUpdate: ({ body }) => {
                // Update-card responses must reuse the callback's req_id.
                this.client.sendWithReqId(WsCmd.RESPONSE_UPDATE, callbackReqId, body)
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
```

- [ ] **Step 4: Run all wecom tests to verify they pass**

Run: `cd hub && bun test src/wecom/`
Expected: PASS across `bot.test.ts`, `callbacks.test.ts`, `renderer.test.ts`, `sessionView.test.ts`.

- [ ] **Step 5: Typecheck**

Run: `bun typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add hub/src/wecom/bot.ts hub/src/wecom/bot.test.ts hub/src/wecom/client.ts
git commit -m "feat(hub/wecom): add WecomBot notification channel + text-binding handler"
```

---

## Task 8: Wire `WecomBot` into the hub

Registers the bot with `NotificationHub` when both credentials are configured and notifications are enabled.

**Files:**
- Modify: `hub/src/index.ts`

### Steps

- [ ] **Step 1: Import `WecomBot`**

Edit `hub/src/index.ts`. Add near the other notification-channel imports (after the `ServerChanChannel` import):

```ts
import { WecomBot } from './wecom/bot'
```

- [ ] **Step 2: Add a `wecomBot` module-level handle**

After `let notificationHub: NotificationHub | null = null`, add:

```ts
let wecomBot: WecomBot | null = null
```

- [ ] **Step 3: Construct `WecomBot` after `NotificationHub` wiring**

Find the block that pushes `HappyBot` into `notificationChannels`:

```ts
    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({ ... })
        if (config.telegramNotification) {
            notificationChannels.push(happyBot)
        }
    }
```

Right after that block (before `notificationHub = new NotificationHub(...)`), insert:

```ts
    // Initialize WeCom bot (optional)
    if (config.wecomEnabled && config.wecomBotId && config.wecomBotSecret && config.wecomNotification) {
        wecomBot = new WecomBot({
            botId: config.wecomBotId,
            secret: config.wecomBotSecret,
            cliApiToken: config.cliApiToken,
            publicUrl: config.publicUrl,
            store,
            syncEngine
        })
        notificationChannels.push(wecomBot)
    }
```

- [ ] **Step 4: Start the bot alongside the Telegram bot**

Find:

```ts
    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }
```

After it, add:

```ts
    if (wecomBot) {
        wecomBot.start()
    }
```

- [ ] **Step 5: Stop the bot on shutdown**

Find the `shutdown` function:

```ts
    const shutdown = async () => {
        console.log('\nShutting down...')
        await tunnelManager?.stop()
        await happyBot?.stop()
        ...
    }
```

Insert after `await happyBot?.stop()`:

```ts
        wecomBot?.stop()
```

- [ ] **Step 6: Typecheck + run all hub tests**

Run: `bun typecheck`
Expected: no errors.

Run: `cd hub && bun test`
Expected: PASS (existing tests + the new wecom suite).

- [ ] **Step 7: Commit**

```bash
git add hub/src/index.ts
git commit -m "feat(hub): wire WeCom bot into NotificationHub + startup/shutdown"
```

---

## Task 9: Documentation

Documents the new env vars and notes on binding. The design spec already covers internal mechanics; the README documents the user-facing knobs.

**Files:**
- Modify: `hub/README.md`

### Steps

- [ ] **Step 1: Add a WeCom section to the Optional config block**

Edit `hub/README.md`. After the ServerChan section (if any) in the "Optional" configuration area, add (and before the generic "Optional" section that lists host/port if that's the structure — otherwise append at the bottom of the Optional block):

```md
### Optional (WeCom)

- `WECOM_BOT_ID` - BotID for a WeCom smart robot (long-connection mode).
- `WECOM_BOT_SECRET` - Secret for the same robot (long-connection mode).
- `WECOM_NOTIFICATION` - Enable/disable WeCom notifications (default: true).

Bind your WeCom user to a namespace by sending `<CLI_API_TOKEN>:<namespace>` as a
text message to the bot in a single chat. The bot replies with a confirmation. Once
bound, permission requests arrive as interactive template cards with Allow / Deny
buttons; ready, task-failure, and session-completion events arrive as text-notice
cards with a link to the session.
```

- [ ] **Step 2: Commit**

```bash
git add hub/README.md
git commit -m "docs(hub): document WECOM_BOT_ID/SECRET/NOTIFICATION config"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full typecheck + test pass**

```bash
bun typecheck
bun run test
```

Expected: all green.

- [ ] **Step 2: Smoke-check the index wiring with the env disabled**

Run the hub with no WeCom env vars set; confirm the startup banner logs `[Hub] WeCom: disabled` and no WebSocket connection is attempted.

```bash
cd hub && bun run src/index.ts
```

Expected output includes: `[Hub] WeCom: disabled (no WECOM_BOT_ID/WECOM_BOT_SECRET)`.
Hit Ctrl+C to stop.

- [ ] **Step 3: (Optional) manual QA against a real WeCom robot**

With a real BotID + Secret, set both env vars, start the hub, bind a user with
`<CLI_API_TOKEN>:<namespace>`, start a session that produces a permission request,
and confirm Allow/Deny works and the card updates. (No automated test covers this;
the Telegram channel is tested the same way.)

---

## Rollback notes

Every task produces a standalone commit. Reverting any single commit reverts only
that slice. Rolling back the full feature is `git revert` against the commits from
Task 1 onward, in reverse order.
