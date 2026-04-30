# WeCom Bot WebSocket Push Channel — Design

Date: 2026-04-30
Status: Draft

## Goal

Add a new hub notification channel that pushes permission requests, ready events,
and task completion events to a WeCom (企业微信) smart robot over its WebSocket long
connection. Permission requests use an interactive template card with Allow / Deny
buttons. When a user clicks a button, the hub updates the card via
`aibot_respond_update_msg` to confirm the outcome.

This extends the existing `NotificationChannel` abstraction (`Telegram`, `ServerChan`,
Web Push) — it does not replace any of them.

## References

- WeCom smart robot long-connection docs: https://developer.work.weixin.qq.com/document/path/101463
- Official SDK (used only for protocol reference, not depended on): `aibot-node-sdk` on npm

## Scope

### In scope

- WebSocket long connection to `wss://openws.work.weixin.qq.com` with
  `aibot_subscribe` auth, 30 s heartbeat, and exponential-backoff reconnect.
- Active push of four notification types via `aibot_send_msg`:
  - Permission request — `template_card` of type `button_interaction` with `Allow` / `Deny`.
  - Ready — `template_card` of type `text_notice` with a session link.
  - Task completed / failed — `template_card` of type `text_notice` with a session link.
  - Session completed — `template_card` of type `text_notice` with a session link.
- Handling the `aibot_event_callback` of type `template_card_event`: approve or deny
  the corresponding permission request in `SyncEngine`, then update the card via
  `aibot_respond_update_msg` within the 5-second budget.
- User binding: when a user sends `<CLI_API_TOKEN>:<namespace>` as text via
  `aibot_msg_callback`, validate and persist the mapping to the existing
  `users` table with `platform='wecom'`.
- Configuration layering (env → settings.json → default) matching the existing
  Telegram / ServerChan pattern.
- Session completion notifications (the `sendSessionCompletion` optional method on
  `NotificationChannel`).

### Out of scope (YAGNI)

- Media upload (images, files, voice, video).
- Streaming replies (`aibot_respond_msg` with `finish=false`).
- Group chat delivery.
- Welcome messages on the `enter_chat` event.
- HTTP / webhook API mode (short-connection fallback).

## Architecture

New module `hub/src/wecom/` laid out to mirror `hub/src/telegram/`:

```
hub/src/wecom/
  client.ts       WecomWSClient — WS state machine, subscribe, heartbeat, reconnect, req_id correlation
  bot.ts          WecomBot — NotificationChannel impl, push + incoming routing
  callbacks.ts    handleCallback(frame, ctx) — template_card_event → approve/deny → update card
  renderer.ts    callback-key codec (action:sessionPrefix:requestPrefix), session-id prefix search
  sessionView.ts  buildPermissionCard / buildReadyCard / buildTaskCard / buildSessionCompletionCard
  bot.test.ts
  callbacks.test.ts
  renderer.test.ts
```

Wiring in `hub/src/index.ts`: if `config.wecomBotId` and `config.wecomBotSecret` are set
and `config.wecomNotification` is true, instantiate `WecomBot`, start it, and push it
onto `notificationChannels`. Shutdown adds `wecomBot?.stop()` to the existing handler.

No new npm dependencies. Bun's native `WebSocket` covers the client side.

## Protocol (what we implement)

### Connection

- URL: `wss://openws.work.weixin.qq.com`
- First frame after open: `{ cmd: "aibot_subscribe", headers: { req_id }, body: { bot_id, secret } }`.
- Subscribe success: `{ headers: { req_id }, errcode: 0, errmsg: "ok" }`.
- Heartbeat: send `{ cmd: "ping", headers: { req_id: "hb-<n>" } }` every 30 s; expect
  a `{ headers: { req_id }, errcode: 0 }` response.

### Connection state machine

```
disconnected → connecting → subscribing → ready
                                           │
             ┌───── subscribe error ───────┘
             ▼
         fatal (auth) — log and stop (no auto-retry on bad credentials)

             ┌───── socket close / missed pong / subscribe timeout ──┐
             ▼                                                        │
        backoff (1 s, 2 s, 4 s … cap 30 s, infinite) ──→ connecting ──┘
```

If we receive an event with `event.eventtype === "disconnected_event"` (the server is
kicking us because a new connection took over), we close and pause reconnect for 30 s
to avoid a thrash loop. Subsequent reconnects resume with the normal backoff.

### Outbound frames

- `aibot_send_msg` — used for all active pushes (permission request, ready, task).
  Body shape: `{ chatid: <userid>, msgtype: "template_card", template_card: {...} }`.
- `aibot_respond_update_msg` — used to update the card after a button click. Body:
  `{ response_type: "update_template_card", template_card: {...} }`. The request
  **must reuse the `req_id` from the incoming `aibot_event_callback` frame** and
  must be sent within 5 s.

### Inbound frames

- `aibot_msg_callback` with `body.msgtype === "text"` — treat as a potential bind
  request: parse `body.text.content` as `<token>:<namespace>`; if `token === config.cliApiToken`
  and namespace is non-empty, call `store.users.addUser("wecom", body.from.userid, namespace)`
  and reply with a confirmation via `aibot_send_msg`. Otherwise ignore.
- `aibot_event_callback` with `body.event.eventtype === "template_card_event"` —
  route to `callbacks.handleCallback`. See below.
- `aibot_event_callback` with `body.event.eventtype === "enter_chat"` — ignored in
  this iteration.
- `aibot_event_callback` with `body.event.eventtype === "disconnected_event"` —
  see state machine above.

### req_id correlation

The client keeps a `Map<req_id, { resolve, reject, timer }>` for outbound frames
where we care about the response (subscribe, ping). `aibot_send_msg` is fire-and-
forget — failure is logged but not retried; the reconnect path handles the common
case (transient drop during push).

## Permission request push

Input: `Session` with `agentState.requests`. Pick the first request (matches
Telegram's behavior — the NotificationHub already debounces / dedupes so we won't
spam one card per request).

Card structure:

```json
{
  "card_type": "button_interaction",
  "main_title": { "title": "Permission Request", "desc": "<session name>" },
  "sub_title_text": "<Tool: ...\n<truncated args>>",
  "button_list": [
    { "text": "Allow", "style": 1, "key": "ap:<sid8>:<req8>" },
    { "text": "Deny",  "style": 2, "key": "dn:<sid8>:<req8>" }
  ],
  "task_id": "hapi-<sid8>-<req8>-<ts>"
}
```

- `sid8` = first 8 chars of `session.id`, `req8` = first 8 chars of the request ID.
- `task_id` format is informative for debugging; the callback binds to the `key`,
  not `task_id`, because WeCom guarantees the clicked button's `event_key` matches
  the `key` we set. WeCom requires `task_id` non-empty and unique per message.
- Key encoding is shared with Telegram (`renderer.ts` format), just without the
  64-byte limit constraint.

Target resolution: `store.users.getUsersByPlatformAndNamespace("wecom", session.namespace)`
yields one or more `userid`s; the card is sent to each. If none bound, skip silently.

## Ready / Task / Session-completion cards

Simpler `text_notice` card with a `main_title` and a `card_action` of
`type: 1, url: <public session url>` that opens the web app when the card body is
tapped. No buttons, no callback.

- Ready: `main_title.title = "Ready for input"`, `desc = "<agent name> · <session name>"`.
- Task completed: `main_title.title = "Task completed"` (or `"Task failed"` when
  `notification.status ∈ {failed, error, killed, aborted}`), `desc` = summary.
  Mirrors ServerChan's filter — only failure statuses get sent for tasks, to match
  the existing ServerChan channel. (If this turns out to be wrong in practice, the
  filter can be relaxed without structural change.)
- Session completed: `main_title.title = "Session completed"`, `desc = "<agent name> · <session name>"`.
  Fires from `NotificationHub`'s `sendSessionCompletion` path.

## Button click handling (callback flow)

On `aibot_event_callback` with `template_card_event`:

1. Extract `event_key`, `from.userid`, and the frame `req_id`.
2. Parse the key: `parseCallbackData(event_key) → { action, sessionPrefix, extra }`.
3. Resolve namespace from userid: `store.users.getUser("wecom", userid)`. If unbound,
   reply with an "unbound" update card and stop.
4. Find the session by prefix within the namespace.
5. Find the pending request by prefix in `session.agentState.requests`.
6. If the session is inactive: update the card to "Session inactive". If the request is missing from `session.agentState.requests` (already handled elsewhere): update the card to "Already processed".
7. Call `syncEngine.approvePermission(session.id, requestId)` or `denyPermission`.
8. Send `aibot_respond_update_msg` with a simple `text_notice` card (
   `main_title.title = "Permission approved."` / `"Permission denied."`), echoing
   the incoming frame's `req_id`.

All of steps 1–8 run inline in the WS message handler so the 5-second window is
safely met (`approvePermission` / `denyPermission` push to Socket.IO but are not
awaited in any blocking way).

## Binding flow

When an `aibot_msg_callback` of `msgtype: "text"` arrives, trim the content and
match against `^<config.cliApiToken>:(.+)$`. On match, upsert the user binding
and reply: `Bound WeCom user <userid> to namespace <namespace>`. On no match,
ignore (no auto-reply to avoid loops with well-meaning users typing "hi").

Unbinding is out of scope; admins can delete rows directly or we can add a
`/unbind` text command in a follow-up.

## Configuration

New fields on `ServerSettings` + env layer (mirror the existing ServerChan block
in `hub/src/config/serverSettings.ts` and the logging in `hub/src/index.ts`):

| Env                 | settings.json key     | Default | Meaning                                          |
|---------------------|-----------------------|---------|--------------------------------------------------|
| `WECOM_BOT_ID`      | `wecomBotId`          | null    | Bot ID from WeCom admin console                  |
| `WECOM_BOT_SECRET`  | `wecomBotSecret`      | null    | Long-connection Secret from the same console     |
| `WECOM_NOTIFICATION`| `wecomNotification`   | true    | Master toggle (matches `TELEGRAM_NOTIFICATION`)  |

Enabled iff both ID and Secret are set and the toggle is true. Also logged in the
startup banner alongside the existing Telegram / ServerChan lines.

`hub/src/configuration.ts` exposes these on the `Configuration` class. No relay /
CORS / public URL changes are needed — outbound WS only.

## Error handling

| Case                                      | Behavior                                                           |
|-------------------------------------------|--------------------------------------------------------------------|
| Missing / wrong credentials (subscribe errcode != 0) | Log prominently, stop reconnecting. Hub continues without WeCom.   |
| Transient WS drop                          | Reconnect with exponential backoff (1 → 2 → 4 … cap 30 s).         |
| `disconnected_event` from server           | Close, pause 30 s, then resume normal reconnect (avoids thrash).   |
| Missed pong                                | Treat as drop; reconnect.                                          |
| `aibot_send_msg` fires while not ready     | Queue the frame in a bounded FIFO (cap 100, drop oldest on overflow); flush on next subscribe success. Subscribe / ping are driven by the state machine and do not use this queue. |
| Callback from unbound userid               | Reply with update card "Not bound"; do not mutate any session.     |
| Callback for request that no longer exists | Update card to "Already processed"; no syncEngine call.            |
| Update exceeds the 5-second window         | Best effort — send anyway; WeCom will silently ignore a late update. |

## Testing

Vitest suites next to the source, matching existing hub test conventions:

- `renderer.test.ts` — `createCallbackData` / `parseCallbackData` round-trip;
  `findSessionByPrefix` / `findRequestByPrefix` helpers.
- `callbacks.test.ts` — `handleCallback` with a stub `SyncEngine`: verifies
  approve/deny dispatch and the shape of the outbound update frame (correct
  `response_type`, `req_id` echoed, card type).
- `bot.test.ts` — with a stub `WecomWSClient`: verifies push frames have the right
  `cmd`, `chatid` list, and `template_card.button_list[].key` values for permission
  requests; verifies the text-message bind handler validates the token and writes
  to `store.users`; smoke tests for the ready / task / session-completion paths.

No live-WebSocket integration test; manual QA with a real WeCom bot covers that
(the Telegram channel follows the same pragmatic approach).

## Rollout

No migration required (the `users` table already has a `platform` column). Deploy
is a code-only change. Existing notification channels are unaffected.

## Open questions

None at spec time. If the 100-item backlog cap proves wrong in practice, tune it —
no structural impact.
