import jwt from 'jsonwebtoken';
import { prisma } from '@repo/db';
import { config } from './config.js';

/**
 * Who is asking, decided from the bearer token and never from the request
 * body.
 *
 * Two kinds of token reach this service, both signed by http-server:
 * - the host's login token, `{ userId }`, and the user in it must be an
 *   accepted organizer of the quiz this session belongs to;
 * - the participant token from `/session/join`, `{ participantId, sessionId }`.
 *   Participant ids are shown to everyone in the lobby and on the leaderboard,
 *   so the id alone proves nothing; the signed token does.
 *
 * The organizer check mirrors apps/ws-server/src/utils/organizerAuth.ts.
 */
export type Caller =
    | { kind: 'organizer'; userId: string; name: string }
    | { kind: 'participant'; participantId: string; username: string };

export function bearerToken(header: string | undefined): string | null {
    if (!header || !header.startsWith('Bearer ')) return null;

    const token = header.slice('Bearer '.length).trim();
    return token === '' ? null : token;
}

function verify(token: string): Record<string, unknown> | null {
    try {
        const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        return typeof decoded === 'object' && decoded !== null ? decoded as Record<string, unknown> : null;
    } catch {
        // Expired, malformed or signed with another secret.
        return null;
    }
}

/** The caller behind this Authorization header for this session, or null. */
export async function resolveCaller(header: string | undefined, sessionId: string): Promise<Caller | null> {
    const token = bearerToken(header);
    if (!token) return null;

    const claims = verify(token);
    if (!claims) return null;

    if (typeof claims.participantId === 'string' && typeof claims.sessionId === 'string') {
        // A token from one quiz must not open the room of another.
        if (claims.sessionId !== sessionId) return null;

        const participant = await prisma.participant.findUnique({
            where: { id: claims.participantId },
            select: { id: true, sessionId: true, username: true },
        });
        if (!participant || participant.sessionId !== sessionId) return null;

        return { kind: 'participant', participantId: participant.id, username: participant.username };
    }

    if (typeof claims.userId === 'string' && claims.userId !== '') {
        const organizer = await prisma.quizOrganizer.findFirst({
            where: {
                userId: claims.userId,
                inviteStatus: 'ACCEPTED',
                quiz: { quizSessions: { some: { id: sessionId } } },
            },
            select: { user: { select: { name: true } } },
        });
        if (!organizer) return null;

        return { kind: 'organizer', userId: claims.userId, name: organizer.user?.name ?? 'Host' };
    }

    return null;
}
