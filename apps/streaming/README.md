# streaming — live video quizzes

Lets a host run a quiz on camera. Hosts and co-hosts are seen and heard; players
watch and listen, show up only as their avatar, and can speak after raising a
hand and being let in by a host. A live video session takes at most
**300 players**.

The video itself goes through a [LiveKit](https://livekit.io) media server
(Apache-2.0, self-hosted, written in Go). This service never touches media. It
decides **who may join which room with which rights**, and it carries out the
host's moderation.

```
  browser ──REST──► streaming (:7000) ──server API──► LiveKit (:7880)
     │                   │  checks JWTs, Postgres             ▲
     │                   └── checks rooms every 10s           │
     └──────────── WebRTC media (UDP 7882 / TCP 7881) ────────┘
```

The quiz itself still runs over `ws-server` exactly as before. Live video is
something extra on top: if the streaming service is down, the quiz still works.

## How a session works

1. In the Quiz Builder the host picks **Host with Video**.
   `POST /quizzes/:id/start-session { liveVideo: true }` (http-server) opens a
   lobby with `QuizSession.liveVideo = true`.
2. Players join as usual. For a live video session, http-server refuses the
   301st join; the count is taken under a row lock, so a join rush cannot
   overshoot. Every join now also returns a signed **participant token**.
3. `ws-server` tells each client `liveVideo: true` in `participants:sync`, and
   the quiz screen asks this service for a room token.
4. The room is created on first request, with LiveKit's participant limit set
   to 300 players plus 20 host seats. The LiveKit server runs with
   `auto_create: false`, so no client can open a room without these limits.
5. The call outlives the quiz. On the final leaderboard the host can talk
   about the results, take questions and let players speak, and players
   who reload can rejoin. Every 10 seconds this service checks the open
   rooms against Postgres and closes the room of a **finished** quiz:
   - 30 seconds after the last host leaves (time to reload the page);
   - at once when the host clicks **End video for everyone**;
   - one hour after the quiz ended, whatever is going on.

   While a quiz is running a room is never closed this way, so a host
   reloading mid-quiz does not end the call. A cancelled session's room
   closes at once, and an empty room closes after 5 minutes.

## Who may do what

| | Host / co-host | Player |
|---|---|---|
| Camera, microphone, screen share | yes | no |
| Microphone | yes | only while a host has let them speak |
| Raise hand | — | yes |
| Let a player speak / mute them | yes | no |
| Change own name or attributes | no | no |

All of this is enforced on the server, by the grants in the LiveKit token and
by LiveKit permission updates, not by the UI. The raised hand and the speaker
flag are participant attributes that only this service writes, so a player
cannot promote themselves. When a host mutes a player, their publish right is
withdrawn and LiveKit stops their microphone.

A player's microphone is **never switched on for them**. Being let in only
enables the Unmute button.

**Tokens.** Hosts authenticate with their normal login JWT, and must be an
accepted organizer of the quiz behind the session (the same check as
`ws-server`'s `organizerAuth.ts`). Players authenticate with the participant
token from `/session/join`, which is bound to one session. Participant ids are
visible to everyone, so an id alone is never accepted. All three Node services
must share one `JWT_SECRET`.

## API

All routes are under `/api/v1/stream`, with `Authorization: Bearer <token>`.

| Route | Who | Does |
|---|---|---|
| `POST /sessions/:sessionId/token` | host, player | Returns `{ url, token, identity, role }` for LiveKit. 409 if the session is not a video one, 410 once it has ended |
| `POST /sessions/:sessionId/hand` `{ raised }` | player | Raise or lower a hand |
| `PUT /sessions/:sessionId/speakers/:participantId` | host | Let a player speak |
| `DELETE /sessions/:sessionId/speakers/:participantId` | host | Take the microphone back |
| `DELETE /sessions/:sessionId/room` | host | End the video for everyone |
| `GET /health` | anyone | Liveness |

## Running it locally

```bash
cp apps/streaming/.env.example apps/streaming/.env   # same JWT_SECRET as http-server

# LiveKit + this service, alongside the usual stack
docker compose --profile streaming up
```

Then start the frontend with `VITE_STREAMING_URL=http://localhost:7000`. Without
that variable the **Host with Video** button is hidden and nothing in the
frontend loads LiveKit.

The dev LiveKit config (`livekit/livekit.dev.yaml`) advertises `127.0.0.1`, so
media works from browsers on the same machine. To join from a phone on the same
Wi‑Fi, set `node_ip` to your laptop's LAN address. Browsers only allow the
camera on `localhost` or HTTPS.

Tests mock Postgres and the LiveKit API but use the real token signing:

```bash
pnpm --filter streaming test
```

## Deploying

Live video is **opt-in** in `docker-compose.prod.yml` (the `streaming`
profile), so an existing deployment is not affected until you turn it on.

1. **Keys.** Generate an API key and a secret of at least 32 characters.
   This service reads them from `.env.prod`:
   ```bash
   LIVEKIT_API_KEY=<key>
   LIVEKIT_API_SECRET=<secret>
   LIVEKIT_PUBLIC_URL=wss://live.<your-domain>
   CORS_ORIGIN=https://<your-domain>
   ```
   The LiveKit container gets the same pair from the `.env` next to
   `docker-compose.prod.yml`, which compose reads automatically:
   ```bash
   COMPOSE_PROFILES=streaming
   LIVEKIT_KEYS="<key>: <secret>"
   ```
   Keep `LIVEKIT_KEYS` out of `.env.prod`, and never give LiveKit
   `.env.prod`: it would pick up `REDIS_HOST` and fail to start in
   multi-node mode. This service refuses to start in production without
   real keys.
2. **Proxy hosts** in nginx-proxy-manager, both with **Websockets Support** on:
   - `stream.<your-domain>` → `streaming:7000`
   - `live.<your-domain>` → `livekit:7880`
3. **Firewall.** Media cannot go through nginx. Open `7881/tcp` and
   `7882/udp` (`ufw allow 7881/tcp && ufw allow 7882/udp`, plus your
   provider's firewall).
4. **Turn it on.** With `COMPOSE_PROFILES=streaming` in that `.env`, the
   next `docker compose -f docker-compose.prod.yml up -d` starts LiveKit and
   this service. CD already builds the `rexial-streaming` image on every
   deploy.
5. **Frontend.** Add `VITE_STREAMING_URL=https://stream.<your-domain>` to
   `apps/frontend/.env.production`. That shows the button to hosts.

### What it costs to run

The software is free. Bandwidth is the real cost: the server sends the host's
video once per viewer. Viewers get a lower-resolution layer when the video tile
is small (simulcast and adaptive stream are on), so a 300-player room needs
something like **100–150 Mbps of upload**. A screen share watched full size
needs more. These figures are estimates, so measure with your own load test
before relying on them, and check your VPS plan's bandwidth cap.

### Strict networks

Some school and office networks block both 7881 and 7882. Players there need
TURN over TLS on port 443, which needs its own domain and certificate. The
LiveKit config has a commented-out `turn:` block to start from; see LiveKit's
[deployment docs](https://docs.livekit.io/home/self-hosting/deployment/).
Without it, those players still get the quiz but not the video.

## Not done yet

- TURN/TLS for networks that block WebRTC (above).
- Text chat, recording and replay are on the roadmap.
- The organizer check is duplicated from `ws-server`. A shared package would
  keep the two from drifting apart.
