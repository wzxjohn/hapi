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
