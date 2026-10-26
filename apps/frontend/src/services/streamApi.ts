import axios from 'axios';

// Live video is optional: without a streaming service configured, the host
// is never offered it and the quiz screens never try to connect.
const streamHost = import.meta.env.VITE_STREAMING_URL as string | undefined;

export const streamingEnabled = Boolean(streamHost);

// A separate client from `api` on purpose: its 401 handler logs the user out,
// and a player who is refused video must not lose the host's login, nor a
// host lose theirs over a video hiccup.
const streamApi = axios.create({
    baseURL: `${streamHost ?? ''}/api/v1/stream`,
    timeout: 10000,
});

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

export const participantTokenKey = (sessionId: string) => `rexial:participant-token:${sessionId}`;

export interface RoomAccess {
    url: string;
    token: string;
    identity: string;
    role: 'organizer' | 'participant';
}

/**
 * A token for the session's video room. `authToken` is the host's login
 * token, or the participant token handed out by /session/join.
 */
export async function fetchRoomAccess(sessionId: string, authToken: string): Promise<RoomAccess> {
    const { data } = await streamApi.post(`/sessions/${sessionId}/token`, {}, auth(authToken));
    return data;
}

export async function setHandRaised(sessionId: string, authToken: string, raised: boolean) {
    await streamApi.post(`/sessions/${sessionId}/hand`, { raised }, auth(authToken));
}

export async function allowToSpeak(sessionId: string, authToken: string, participantId: string) {
    await streamApi.put(`/sessions/${sessionId}/speakers/${participantId}`, {}, auth(authToken));
}

export async function stopSpeaking(sessionId: string, authToken: string, participantId: string) {
    await streamApi.delete(`/sessions/${sessionId}/speakers/${participantId}`, auth(authToken));
}

/** Close the session's video room for everyone. Host only. */
export async function endVideo(sessionId: string, authToken: string) {
    await streamApi.delete(`/sessions/${sessionId}/room`, auth(authToken));
}

/** The server's message for a failed request, or a fallback. */
export function streamError(err: unknown, fallback: string): string {
    const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
    return message || fallback;
}
