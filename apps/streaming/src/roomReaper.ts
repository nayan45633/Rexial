import { prisma } from '@repo/db';
import { closeRoom, roomService, sessionIdOf } from './livekit.js';

/**
 * Closes video rooms once there is no reason to keep them.
 *
 * A room outlives its quiz on purpose: the final leaderboard is when a host
 * says a few words about the results, so the call carries on until the host
 * leaves. While the quiz is running a room is never touched here, so a host
 * reloading mid-quiz does not end the call for everyone.
 *
 * Polling rather than listening for events, so nothing is lost across a
 * restart of this service: every check reads the rooms from LiveKit and the
 * session state from Postgres.
 */

/** How often rooms are checked. */
export const REAP_INTERVAL_MS = 10_000;

/**
 * How long a finished quiz's room stays open with no host in it. Long enough
 * for a host to reload the final screen and come back, short enough that the
 * players are not left looking at an empty call.
 */
export const HOST_GRACE_MS = 30_000;

/** A finished quiz's room is closed after this long however it is going. */
export const MAX_OPEN_AFTER_END_MS = 60 * 60_000;

// Room name -> when a host was last seen in it after the quiz ended.
const lastHostSeen = new Map<string, number>();

async function close(room: string, sessionId: string, reason: string) {
    await closeRoom(sessionId);
    lastHostSeen.delete(room);
    console.log(`[streaming] closed room ${room}: ${reason}`);
}

/** One pass over the open rooms. Exported for tests. */
export async function reapRooms(now = Date.now()) {
    const rooms = (await roomService.listRooms())
        .map((r) => ({ room: r.name, sessionId: sessionIdOf(r.name) }))
        .filter((r): r is { room: string; sessionId: string } => r.sessionId !== null);

    // Forget rooms that closed some other way.
    const open = new Set(rooms.map((r) => r.room));
    for (const room of lastHostSeen.keys()) {
        if (!open.has(room)) lastHostSeen.delete(room);
    }

    if (rooms.length === 0) return;

    const sessions = await prisma.quizSession.findMany({
        where: { id: { in: rooms.map((r) => r.sessionId) } },
        select: { id: true, status: true, endedAt: true },
    });
    const byId = new Map(sessions.map((s) => [s.id, s]));

    for (const { room, sessionId } of rooms) {
        const session = byId.get(sessionId);

        if (!session || session.status === 'CANCELLED') {
            await close(room, sessionId, 'session cancelled or gone');
            continue;
        }

        // The quiz is still on: the room is the quiz's, leave it be.
        if (session.status !== 'COMPLETED') {
            lastHostSeen.delete(room);
            continue;
        }

        if (session.endedAt && now - session.endedAt.getTime() >= MAX_OPEN_AFTER_END_MS) {
            await close(room, sessionId, 'open too long after the quiz ended');
            continue;
        }

        const participants = await roomService.listParticipants(room);
        if (participants.some((p) => p.attributes?.role === 'host')) {
            lastHostSeen.set(room, now);
            continue;
        }

        // First pass with no host: the grace period starts now.
        const since = lastHostSeen.get(room);
        if (since === undefined) {
            lastHostSeen.set(room, now);
        } else if (now - since >= HOST_GRACE_MS) {
            await close(room, sessionId, 'the host left after the quiz ended');
        }
    }
}

export function startRoomReaper() {
    let running = false;

    return setInterval(async () => {
        // A slow pass must not overlap the next one.
        if (running) return;
        running = true;
        try {
            await reapRooms();
        } catch (err) {
            console.error('[streaming] room check failed', err);
        } finally {
            running = false;
        }
    }, REAP_INTERVAL_MS);
}
