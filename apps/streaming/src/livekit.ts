import { AccessToken, RoomServiceClient, ServerError, TrackSource } from 'livekit-server-sdk';
import type { ParticipantPermission } from 'livekit-server-sdk';
import { config } from './config.js';
import type { Caller } from './auth.js';

/**
 * Most players a live video session takes. Must match
 * MAX_LIVE_VIDEO_PARTICIPANTS in apps/http-server, which refuses the 301st
 * join; the room limit here is the backstop if that check is ever bypassed.
 */
export const MAX_LIVE_VIDEO_PARTICIPANTS = 300;

/** Seats on top of the players, for the host and co-hosts. */
const HOST_SEATS = 20;

/** Close a room nobody has joined, or everyone has left, after this long. */
const EMPTY_TIMEOUT_S = 5 * 60;
const DEPARTURE_TIMEOUT_S = 60;

export const roomService = new RoomServiceClient(
    config.livekit.url,
    config.livekit.apiKey,
    config.livekit.apiSecret,
);

const ROOM_PREFIX = 'quiz-';

export const roomName = (sessionId: string) => `${ROOM_PREFIX}${sessionId}`;

/** The session a room belongs to, or null for a room this service did not name. */
export const sessionIdOf = (room: string) =>
    room.startsWith(ROOM_PREFIX) ? room.slice(ROOM_PREFIX.length) : null;

/** Close a room, treating one that is already gone as closed. */
export async function closeRoom(sessionId: string) {
    try {
        await roomService.deleteRoom(roomName(sessionId));
    } catch (err) {
        if (err instanceof ServerError && err.status === 404) return;
        throw err;
    }
}

export const playerIdentity = (participantId: string) => `player-${participantId}`;

export function identityOf(caller: Caller): string {
    return caller.kind === 'organizer' ? `host-${caller.userId}` : playerIdentity(caller.participantId);
}

/**
 * Create the session's room, or leave it as it is if it already exists.
 *
 * The LiveKit server runs with auto_create off, so a room only exists once
 * this has run, and always with the participant limit set.
 */
export async function ensureRoom(sessionId: string) {
    await roomService.createRoom({
        name: roomName(sessionId),
        maxParticipants: MAX_LIVE_VIDEO_PARTICIPANTS + HOST_SEATS,
        emptyTimeout: EMPTY_TIMEOUT_S,
        departureTimeout: DEPARTURE_TIMEOUT_S,
    });
}

/**
 * What a player may do while the host has given them the floor: speak, and
 * nothing else. No camera, no screen share, so a player only ever appears as
 * their avatar.
 */
export const SPEAKER_PERMISSION: Partial<ParticipantPermission> = {
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE],
    canUpdateMetadata: false,
};

/**
 * A player's default: watch and listen only. Taking canPublish away also
 * makes LiveKit unpublish a microphone that is still on.
 */
export const LISTENER_PERMISSION: Partial<ParticipantPermission> = {
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    canUpdateMetadata: false,
};

/**
 * A token to join the session's room.
 *
 * Hosts and co-hosts may publish camera, microphone and screen share. Players
 * start as listeners; the host promotes one with SPEAKER_PERMISSION. Nobody
 * may set their own name or attributes: the hand and speaker flags are only
 * ever written here, so a player cannot mark themselves as a speaker.
 */
export async function createJoinToken(sessionId: string, caller: Caller): Promise<string> {
    const isHost = caller.kind === 'organizer';

    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: identityOf(caller),
        name: isHost ? caller.name : caller.username,
        // Only used to connect; LiveKit refreshes it for the life of the
        // connection, and the client asks for a new one to reconnect.
        ttl: '1h',
        attributes: isHost
            ? { role: 'host' }
            : { role: 'player', participantId: caller.participantId },
    });

    token.addGrant({
        room: roomName(sessionId),
        roomJoin: true,
        canSubscribe: true,
        canPublish: isHost,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        // An empty list would mean "any source" to LiveKit, so a player's
        // token leaves it out and relies on canPublish being false.
        ...(isHost && {
            canPublishSources: [
                TrackSource.CAMERA,
                TrackSource.MICROPHONE,
                TrackSource.SCREEN_SHARE,
                TrackSource.SCREEN_SHARE_AUDIO,
            ],
        }),
    });

    return token.toJwt();
}
