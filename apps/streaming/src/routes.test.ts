import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const mocks = vi.hoisted(() => {
    process.env.JWT_SECRET = "test-secret";

    return {
        prisma: {
            participant: { findUnique: vi.fn() },
            quizOrganizer: { findFirst: vi.fn() },
            quizSession: { findUnique: vi.fn() },
        },
        createRoom: vi.fn(),
        updateParticipant: vi.fn(),
        listRooms: vi.fn(),
        deleteRoom: vi.fn(),
    };
});

vi.mock("@repo/db", () => ({ prisma: mocks.prisma }));

// Only the calls to the LiveKit server are faked. Tokens are minted by the
// real SDK, so the tests read back the grants a browser would actually get.
vi.mock("livekit-server-sdk", async (importOriginal) => {
    const actual = await importOriginal<typeof import("livekit-server-sdk")>();

    class RoomServiceClient {
        createRoom = mocks.createRoom;
        updateParticipant = mocks.updateParticipant;
        listRooms = mocks.listRooms;
        deleteRoom = mocks.deleteRoom;
    }

    return { ...actual, RoomServiceClient };
});

import { ServerError } from "livekit-server-sdk";
import { createApp } from "./app.js";

const SECRET = "test-secret";
const SESSION = "session-1";

const hostToken = (userId = "host-1") => jwt.sign({ userId }, SECRET);
const playerToken = (participantId = "p-1", sessionId = SESSION) =>
    jwt.sign({ participantId, sessionId }, SECRET);

let server: Server;
let base: string;

beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/stream`;
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    vi.clearAllMocks();

    mocks.prisma.quizSession.findUnique.mockResolvedValue({ status: "WAITING", liveVideo: true });
    mocks.prisma.participant.findUnique.mockResolvedValue({ id: "p-1", sessionId: SESSION, username: "Asha" });
    mocks.prisma.quizOrganizer.findFirst.mockImplementation(async ({ where }) =>
        where.userId === "host-1" ? { user: { name: "Ms. Rao" } } : null
    );
    mocks.createRoom.mockResolvedValue({});
    mocks.updateParticipant.mockResolvedValue({});
    mocks.listRooms.mockResolvedValue([]);
    mocks.deleteRoom.mockResolvedValue(undefined);
});

function call(method: string, path: string, token?: string, body?: unknown) {
    return fetch(`${base}${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

/** The claims inside a LiveKit token, without checking its signature. */
function livekitClaims(token: string) {
    return jwt.decode(token) as {
        sub: string;
        name: string;
        attributes?: Record<string, string>;
        video: Record<string, unknown>;
    };
}

describe("joining the video room", () => {
    it("refuses a request without a token", async () => {
        const res = await call("POST", `/sessions/${SESSION}/token`);
        expect(res.status).toBe(401);
        expect(mocks.createRoom).not.toHaveBeenCalled();
    });

    it("refuses a token signed with another secret", async () => {
        const forged = jwt.sign({ userId: "host-1" }, "not-the-secret");
        const res = await call("POST", `/sessions/${SESSION}/token`, forged);
        expect(res.status).toBe(401);
    });

    it("refuses a logged-in user who is not an organizer of this quiz", async () => {
        const res = await call("POST", `/sessions/${SESSION}/token`, hostToken("someone-else"));
        expect(res.status).toBe(401);
    });

    it("refuses a player token issued for another session", async () => {
        const res = await call("POST", `/sessions/${SESSION}/token`, playerToken("p-1", "session-2"));
        expect(res.status).toBe(401);
    });

    it("refuses a player whose row belongs to another session", async () => {
        mocks.prisma.participant.findUnique.mockResolvedValue({ id: "p-1", sessionId: "session-2", username: "Asha" });
        const res = await call("POST", `/sessions/${SESSION}/token`, playerToken());
        expect(res.status).toBe(401);
    });

    it("refuses a session that is not a live video one", async () => {
        mocks.prisma.quizSession.findUnique.mockResolvedValue({ status: "WAITING", liveVideo: false });
        const res = await call("POST", `/sessions/${SESSION}/token`, hostToken());
        expect(res.status).toBe(409);
    });

    it("refuses a finished quiz whose room has closed", async () => {
        mocks.prisma.quizSession.findUnique.mockResolvedValue({ status: "COMPLETED", liveVideo: true });
        const res = await call("POST", `/sessions/${SESSION}/token`, playerToken());
        expect(res.status).toBe(410);
        expect(mocks.createRoom).not.toHaveBeenCalled();
    });

    it("lets people back into a finished quiz's room while the host keeps it open", async () => {
        mocks.prisma.quizSession.findUnique.mockResolvedValue({ status: "COMPLETED", liveVideo: true });
        mocks.listRooms.mockResolvedValue([{ name: `quiz-${SESSION}` }]);

        const res = await call("POST", `/sessions/${SESSION}/token`, playerToken());
        expect(res.status).toBe(200);
        // Rejoined, never reopened.
        expect(mocks.createRoom).not.toHaveBeenCalled();
    });

    it("refuses a cancelled session even if its room is still open", async () => {
        mocks.prisma.quizSession.findUnique.mockResolvedValue({ status: "CANCELLED", liveVideo: true });
        mocks.listRooms.mockResolvedValue([{ name: `quiz-${SESSION}` }]);
        const res = await call("POST", `/sessions/${SESSION}/token`, hostToken());
        expect(res.status).toBe(410);
    });

    it("creates the room with room for 300 players plus hosts", async () => {
        await call("POST", `/sessions/${SESSION}/token`, playerToken());

        expect(mocks.createRoom).toHaveBeenCalledWith(
            expect.objectContaining({ name: `quiz-${SESSION}`, maxParticipants: 320 })
        );
    });

    it("lets the host publish camera, microphone and screen", async () => {
        const res = await call("POST", `/sessions/${SESSION}/token`, hostToken());
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.role).toBe("organizer");

        const claims = livekitClaims(body.token);
        expect(claims.sub).toBe("host-host-1");
        expect(claims.name).toBe("Ms. Rao");
        expect(claims.video).toMatchObject({
            room: `quiz-${SESSION}`,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: false,
            canUpdateOwnMetadata: false,
        });
        expect(claims.video.canPublishSources).toEqual(
            expect.arrayContaining(["camera", "microphone", "screen_share"])
        );
    });

    it("gives a player a watch-and-listen token", async () => {
        const res = await call("POST", `/sessions/${SESSION}/token`, playerToken());
        expect(res.status).toBe(200);

        const claims = livekitClaims((await res.json()).token);
        expect(claims.sub).toBe("player-p-1");
        expect(claims.name).toBe("Asha");
        expect(claims.attributes).toEqual({ role: "player", participantId: "p-1" });
        expect(claims.video).toMatchObject({
            canPublish: false,
            canSubscribe: true,
            canPublishData: false,
            canUpdateOwnMetadata: false,
        });
        expect(claims.video.canPublishSources).toBeUndefined();
    });
});

describe("raising a hand", () => {
    it("is written on the player's own participant", async () => {
        const res = await call("POST", `/sessions/${SESSION}/hand`, playerToken(), { raised: true });
        expect(res.status).toBe(200);

        expect(mocks.updateParticipant).toHaveBeenCalledWith(`quiz-${SESSION}`, "player-p-1", {
            attributes: { hand: "up" },
        });
    });

    it("clears the flag when lowered", async () => {
        await call("POST", `/sessions/${SESSION}/hand`, playerToken(), { raised: false });

        expect(mocks.updateParticipant).toHaveBeenCalledWith(`quiz-${SESSION}`, "player-p-1", {
            attributes: { hand: "" },
        });
    });

    it("is not something a host does", async () => {
        const res = await call("POST", `/sessions/${SESSION}/hand`, hostToken(), { raised: true });
        expect(res.status).toBe(403);
        expect(mocks.updateParticipant).not.toHaveBeenCalled();
    });

    it("answers 404 when the player is not in the room", async () => {
        mocks.updateParticipant.mockRejectedValue(new ServerError("not_found", "participant not found", 404));

        const res = await call("POST", `/sessions/${SESSION}/hand`, playerToken(), { raised: true });
        expect(res.status).toBe(404);
    });
});

describe("letting a player speak", () => {
    it("is refused to a player, even for themselves", async () => {
        const res = await call("PUT", `/sessions/${SESSION}/speakers/p-1`, playerToken());
        expect(res.status).toBe(403);

        const mute = await call("DELETE", `/sessions/${SESSION}/speakers/p-2`, playerToken());
        expect(mute.status).toBe(403);

        expect(mocks.updateParticipant).not.toHaveBeenCalled();
    });

    it("grants the host's pick the microphone and nothing else", async () => {
        const res = await call("PUT", `/sessions/${SESSION}/speakers/p-1`, hostToken());
        expect(res.status).toBe(200);

        const [room, identity, options] = mocks.updateParticipant.mock.calls[0]!;
        expect(room).toBe(`quiz-${SESSION}`);
        expect(identity).toBe("player-p-1");
        expect(options.attributes).toEqual({ speaker: "yes", hand: "" });
        expect(options.permission).toMatchObject({ canPublish: true, canPublishData: false });
        // TrackSource.MICROPHONE
        expect(options.permission.canPublishSources).toHaveLength(1);
    });

    it("takes the microphone back", async () => {
        const res = await call("DELETE", `/sessions/${SESSION}/speakers/p-1`, hostToken());
        expect(res.status).toBe(200);

        const [, identity, options] = mocks.updateParticipant.mock.calls[0]!;
        expect(identity).toBe("player-p-1");
        expect(options.attributes).toEqual({ speaker: "" });
        expect(options.permission).toMatchObject({ canPublish: false });
    });
});

describe("ending the video", () => {
    it("closes the room for everyone when the host asks", async () => {
        const res = await call("DELETE", `/sessions/${SESSION}/room`, hostToken());
        expect(res.status).toBe(200);
        expect(mocks.deleteRoom).toHaveBeenCalledWith(`quiz-${SESSION}`);
    });

    it("treats a room that is already gone as closed", async () => {
        mocks.deleteRoom.mockRejectedValue(new ServerError("not_found", "room not found", 404));
        const res = await call("DELETE", `/sessions/${SESSION}/room`, hostToken());
        expect(res.status).toBe(200);
    });

    it("is refused to a player", async () => {
        const res = await call("DELETE", `/sessions/${SESSION}/room`, playerToken());
        expect(res.status).toBe(403);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
    });
});
