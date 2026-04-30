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
