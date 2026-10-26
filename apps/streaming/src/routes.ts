import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '@repo/db';
import { resolveCaller } from './auth.js';
import type { Caller } from './auth.js';
import { config } from './config.js';
import {
    LISTENER_PERMISSION,
    SPEAKER_PERMISSION,
    closeRoom,
    createJoinToken,
    ensureRoom,
    identityOf,
    playerIdentity,
    roomName,
    roomService,
} from './livekit.js';

const router: Router = Router();

/** Same error shape as http-server, so the frontend reads both the same way. */
function errorResponse(res: Response, statusCode: number, message: string) {
    return res.status(statusCode).json({ success: false, error: message });
}

/** The caller for this session, or null after answering 401. */
async function requireCaller(req: Request<{ sessionId: string }>, res: Response): Promise<Caller | null> {
    const caller = await resolveCaller(req.headers.authorization, req.params.sessionId);
    if (!caller) {
        errorResponse(res, 401, 'You are not part of this quiz.');
        return null;
    }
    return caller;
}


/**
 * A token to join the session's video room.
 *
 * Hosts get one that can publish; players get a watch-and-listen token. The
 * session must be a live video one that has not finished.
 */
router.post('/sessions/:sessionId/token', async (req: Request<{ sessionId: string }>, res) => {
    const { sessionId } = req.params;

    const caller = await requireCaller(req, res);
    if (!caller) return;

    const session = await prisma.quizSession.findUnique({
        where: { id: sessionId },
        select: { status: true, liveVideo: true },
    });

    if (!session) return errorResponse(res, 404, 'Quiz session not found.');
    if (!session.liveVideo) return errorResponse(res, 409, 'This quiz is not running with live video.');
    if (session.status === 'CANCELLED') return errorResponse(res, 410, 'This quiz has ended.');

    if (session.status === 'COMPLETED') {
        // After the final leaderboard the call carries on only while the host
        // keeps it open (see roomReaper). Rejoining it, after a reload say, is
        // fine; opening a fresh room for a finished quiz is not.
        const [room] = await roomService.listRooms([roomName(sessionId)]);
        if (!room) return errorResponse(res, 410, 'This quiz has ended.');
    } else {
        await ensureRoom(sessionId);
    }

    return res.status(200).json({
        url: config.livekit.publicUrl,
        token: await createJoinToken(sessionId, caller),
        identity: identityOf(caller),
        role: caller.kind,
    });
});


/**
 * Raise or lower a player's hand.
 *
 * Written as a participant attribute by the server rather than by the player,
 * whose token cannot change its own attributes; every client in the room sees
 * the change, and the host's list of raised hands is built from it.
 */
router.post('/sessions/:sessionId/hand', async (req: Request<{ sessionId: string }>, res) => {
    const caller = await requireCaller(req, res);
    if (!caller) return;

    if (caller.kind !== 'participant') {
        return errorResponse(res, 403, 'Only players raise a hand.');
    }

    const raised = req.body?.raised === true;

    await roomService.updateParticipant(roomName(req.params.sessionId), identityOf(caller), {
        attributes: { hand: raised ? 'up' : '' },
    });

    return res.status(200).json({ raised });
});


type SpeakerParams = { sessionId: string; participantId: string };

/** Give a player the floor: they may now turn their microphone on. */
router.put('/sessions/:sessionId/speakers/:participantId', async (req: Request<SpeakerParams>, res) => {
    const caller = await requireCaller(req, res);
    if (!caller) return;

    if (caller.kind !== 'organizer') {
        return errorResponse(res, 403, 'Only the host can let a player speak.');
    }

    await roomService.updateParticipant(roomName(req.params.sessionId), playerIdentity(req.params.participantId), {
        permission: SPEAKER_PERMISSION,
        // Being heard answers the raised hand.
        attributes: { speaker: 'yes', hand: '' },
    });

    return res.status(200).json({ speaking: true });
});


/** Take the floor back. LiveKit stops a microphone that is still on. */
router.delete('/sessions/:sessionId/speakers/:participantId', async (req: Request<SpeakerParams>, res) => {
    const caller = await requireCaller(req, res);
    if (!caller) return;

    if (caller.kind !== 'organizer') {
        return errorResponse(res, 403, 'Only the host can mute a player.');
    }

    await roomService.updateParticipant(roomName(req.params.sessionId), playerIdentity(req.params.participantId), {
        permission: LISTENER_PERMISSION,
        attributes: { speaker: '' },
    });

    return res.status(200).json({ speaking: false });
});

/**
 * End the video for everyone, the host's way of closing the call after the
 * results. Leaving the page has the same effect after a short grace period.
 */
router.delete('/sessions/:sessionId/room', async (req: Request<{ sessionId: string }>, res) => {
    const caller = await requireCaller(req, res);
    if (!caller) return;

    if (caller.kind !== 'organizer') {
        return errorResponse(res, 403, 'Only the host can end the video.');
    }

    await closeRoom(req.params.sessionId);
    return res.status(200).json({ closed: true });
});

export default router;
