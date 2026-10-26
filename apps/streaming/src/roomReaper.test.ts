import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    listRooms: vi.fn(),
    listParticipants: vi.fn(),
    deleteRoom: vi.fn(),
}));

vi.mock("@repo/db", () => ({ prisma: { quizSession: { findMany: mocks.findMany } } }));

vi.mock("livekit-server-sdk", async (importOriginal) => {
    const actual = await importOriginal<typeof import("livekit-server-sdk")>();

    class RoomServiceClient {
        listRooms = mocks.listRooms;
        listParticipants = mocks.listParticipants;
        deleteRoom = mocks.deleteRoom;
    }

    return { ...actual, RoomServiceClient };
});

import { HOST_GRACE_MS, MAX_OPEN_AFTER_END_MS, reapRooms } from "./roomReaper.js";

const T0 = Date.parse("2026-10-25T12:00:00Z");
const host = { identity: "host-u1", attributes: { role: "host" } };
const player = { identity: "player-p1", attributes: { role: "player", participantId: "p1" } };

let n = 0;
let id: string;

function setUp(status: string, endedAt: number | null, participants: object[]) {
    mocks.listRooms.mockResolvedValue([{ name: `quiz-${id}` }]);
    mocks.findMany.mockResolvedValue([{ id, status, endedAt: endedAt === null ? null : new Date(endedAt) }]);
    mocks.listParticipants.mockResolvedValue(participants);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteRoom.mockResolvedValue(undefined);
    // A fresh session per test, so the grace timers do not carry over.
    id = `s${++n}`;
});

describe("a running quiz", () => {
    it("keeps its room even with no host in it, so a host can reload", async () => {
        setUp("IN_PROGRESS", null, [player]);
        await reapRooms(T0);
        await reapRooms(T0 + HOST_GRACE_MS * 10);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
        expect(mocks.listParticipants).not.toHaveBeenCalled();
    });
});

describe("after the final leaderboard", () => {
    it("keeps the call going while a host is in it", async () => {
        setUp("COMPLETED", T0, [host, player]);
        await reapRooms(T0 + 1_000);
        await reapRooms(T0 + 20 * 60_000);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
    });

    it("closes it once the host has been gone for the grace period", async () => {
        setUp("COMPLETED", T0, [host, player]);
        await reapRooms(T0);

        mocks.listParticipants.mockResolvedValue([player]);
        await reapRooms(T0 + HOST_GRACE_MS - 1);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();

        await reapRooms(T0 + HOST_GRACE_MS);
        expect(mocks.deleteRoom).toHaveBeenCalledWith(`quiz-${id}`);
    });

    it("does not close it when the host comes back within the grace period", async () => {
        setUp("COMPLETED", T0, [player]);
        await reapRooms(T0);

        mocks.listParticipants.mockResolvedValue([host, player]);
        await reapRooms(T0 + HOST_GRACE_MS / 2);

        mocks.listParticipants.mockResolvedValue([player]);
        await reapRooms(T0 + HOST_GRACE_MS + 1);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
    });

    it("starts the grace period when it first finds no host", async () => {
        setUp("COMPLETED", T0, [player]);
        await reapRooms(T0 + 5 * 60_000);
        expect(mocks.deleteRoom).not.toHaveBeenCalled();

        await reapRooms(T0 + 5 * 60_000 + HOST_GRACE_MS);
        expect(mocks.deleteRoom).toHaveBeenCalledTimes(1);
    });

    it("closes it after the time limit even with the host still there", async () => {
        setUp("COMPLETED", T0, [host]);
        await reapRooms(T0 + MAX_OPEN_AFTER_END_MS);
        expect(mocks.deleteRoom).toHaveBeenCalledWith(`quiz-${id}`);
    });
});

describe("rooms with no live quiz behind them", () => {
    it("closes the room of a cancelled session at once", async () => {
        setUp("CANCELLED", null, [host]);
        await reapRooms(T0);
        expect(mocks.deleteRoom).toHaveBeenCalledWith(`quiz-${id}`);
    });

    it("closes the room of a session that no longer exists", async () => {
        mocks.listRooms.mockResolvedValue([{ name: `quiz-${id}` }]);
        mocks.findMany.mockResolvedValue([]);
        await reapRooms(T0);
        expect(mocks.deleteRoom).toHaveBeenCalledWith(`quiz-${id}`);
    });

    it("leaves rooms it did not create alone", async () => {
        mocks.listRooms.mockResolvedValue([{ name: "someone-elses-room" }]);
        await reapRooms(T0);
        expect(mocks.findMany).not.toHaveBeenCalled();
        expect(mocks.deleteRoom).not.toHaveBeenCalled();
    });
});
