import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  VideoTrack,
  isTrackReference,
  useLocalParticipant,
  useLocalParticipantPermissions,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { DisconnectReason, RoomEvent, Track } from 'livekit-client';
import type { Participant } from 'livekit-client';
import { BsCameraVideo, BsCameraVideoOff, BsMic, BsMicMute } from 'react-icons/bs';
import { MdScreenShare, MdStopScreenShare } from 'react-icons/md';
import { FaHand } from 'react-icons/fa6';
import { LuChevronDown, LuMaximize2, LuMinimize2 } from 'react-icons/lu';
import { getAvatar, getAvatarColor } from '../../utils/Avatars';
import {
  allowToSpeak,
  endVideo,
  fetchRoomAccess,
  setHandRaised,
  stopSpeaking,
  streamError,
} from '../../services/streamApi';
import type { RoomAccess } from '../../services/streamApi';

interface LiveStageProps {
  sessionId: string;
  isOrganizer: boolean;
  /** The host's login token, or the participant token from /session/join. */
  authToken: string | null;
  /** The final leaderboard is up; the host may now end the call. */
  quizEnded: boolean;
}

/**
 * The host's live video, floating over whichever quiz screen is showing.
 *
 * Hosts and co-hosts are on camera. Players watch and listen, appear only as
 * their avatar, and speak only after raising a hand and being let in by a
 * host. What anyone may publish is enforced by the streaming service and
 * LiveKit, not by this component; the buttons here only ask.
 *
 * Mounted once for the whole quiz (LiveQuiz keeps it outside the per-state
 * screens), so moving between questions never drops the call.
 */
function LiveStage({ sessionId, isOrganizer, authToken, quizEnded }: LiveStageProps) {
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // Bumped to ask for a fresh token after a failure.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!authToken) return;

    let cancelled = false;
    fetchRoomAccess(sessionId, authToken)
      .then((granted) => {
        if (!cancelled) setAccess(granted);
      })
      .catch((err) => {
        if (!cancelled) setError(streamError(err, "Couldn't connect to the live video."));
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, authToken, attempt]);

  const retry = () => {
    setError(null);
    setAccess(null);
    setAttempt((n) => n + 1);
  };

  if (ended) return null;

  return (
    <>
      {/* Below xl the stage is a bar across the top of the screen. This holds
          its height in the page, so the quiz moves down instead of the timer
          and answer count ending up underneath the video. */}
      <div aria-hidden="true" className={`xl:hidden ${minimized ? 'h-8' : 'h-[8.5rem] sm:h-[10.5rem]'}`} />

      <aside
        aria-label="Live video"
        className="fixed z-90 top-0 inset-x-0 border-b xl:border xl:top-14 xl:left-auto xl:right-6 xl:w-64 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto xl:rounded-2xl border-pink-700/40 bg-zinc-950/95 backdrop-blur-md shadow-xl shadow-pink-900/30"
      >
        <div className="flex items-center justify-between h-8 px-3">
          <span className="flex items-center gap-2 text-xs sm:text-sm font-secondary font-bold tracking-widest text-gray-200">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
            LIVE
          </span>
          <button
            onClick={() => setMinimized((m) => !m)}
            className="p-1 text-zinc-400 hover:text-gray-100 cursor-pointer"
            aria-label={minimized ? 'Show live video' : 'Hide live video'}
            aria-expanded={!minimized}
          >
            {minimized ? <LuMaximize2 className="w-4 h-4" /> : <LuMinimize2 className="w-4 h-4" />}
          </button>
        </div>

        {/* Hidden, not unmounted, when minimized: the host stays audible, and
            LiveKit stops sending video to an element nobody can see. */}
        <div className={minimized ? 'hidden' : 'h-[6.5rem] sm:h-[8.5rem] px-3 pb-2 xl:h-auto xl:pb-3'}>
          {!authToken && (
            <p className="text-xs sm:text-sm text-zinc-400 font-secondary">
              Rejoin the quiz from the join page to see the host.
            </p>
          )}

          {error && (
            <div className="text-xs sm:text-sm text-rose-300 font-secondary space-y-2">
              <p role="alert">{error}</p>
              <button onClick={retry} className="underline cursor-pointer">Try again</button>
            </div>
          )}

          {access && (
            <LiveKitRoom
              // A fresh token means a fresh connection.
              key={access.token}
              serverUrl={access.url}
              token={access.token}
              connect
              // The host chose a video quiz, so their camera and mic start on.
              // Players never publish until a host lets them speak.
              video={isOrganizer}
              audio={isOrganizer}
              options={{ adaptiveStream: true, dynacast: true }}
              onDisconnected={(reason) => {
                if (reason === DisconnectReason.ROOM_DELETED) {
                  setEnded(true);
                } else if (reason !== DisconnectReason.CLIENT_INITIATED) {
                  setAccess(null);
                  setError('The live video disconnected.');
                }
              }}
              onMediaDeviceFailure={() =>
                setError('Your camera or microphone is blocked. Allow it in the browser to be seen and heard.')
              }
              className="h-full"
            >
              <Stage sessionId={sessionId} isOrganizer={isOrganizer} authToken={authToken!} quizEnded={quizEnded} />
              <RoomAudioRenderer />
              {/* Browsers block sound until the page is touched; this only
                  shows while that is the case. */}
              <StartAudio
                label="Tap to hear the host"
                className="absolute inset-x-3 bottom-2 py-2 rounded-lg bg-pink-600 text-black font-secondary font-bold text-sm cursor-pointer"
              />
            </LiveKitRoom>
          )}
        </div>
      </aside>
    </>
  );
}


/**
 * Room events that change what the stage shows. Listed rather than left to
 * the default, which also re-renders on every speaking-level change; with 300
 * people in the room that is a lot of renders for nothing.
 */
const STAGE_EVENTS = [
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantPermissionsChanged,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
];

const isHost = (p: Participant) => p.attributes.role === 'host';

interface StageProps {
  sessionId: string;
  isOrganizer: boolean;
  authToken: string;
  quizEnded: boolean;
}

function Stage({ sessionId, isOrganizer, authToken, quizEnded }: StageProps) {
  const participants = useParticipants({ updateOnlyOn: STAGE_EVENTS });

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false, updateOnlyOn: STAGE_EVENTS },
  );

  const hostTracks = tracks.filter((t) => isHost(t.participant));
  const screen = hostTracks.find((t) => t.source === Track.Source.ScreenShare);
  const cameras = hostTracks.filter((t) => t.source === Track.Source.Camera);

  const players = participants.filter((p) => !isHost(p));
  const speakers = players.filter((p) => p.attributes.speaker === 'yes');
  const hands = players.filter((p) => p.attributes.hand === 'up');

  // The host's full list of who is in the room, opened from the count.
  const [rosterOpen, setRosterOpen] = useState(false);
  const watching = `${players.length} ${players.length === 1 ? 'player' : 'players'} watching`;

  const hostActions = (p: Participant) => (
    <HostRowActions participant={p} sessionId={sessionId} authToken={authToken} />
  );

  // A row (video, then everything else) in the top bar; a column in the
  // floating card on wide screens.
  return (
    <div className="flex gap-3 h-full xl:block xl:h-auto">
      <div className="flex gap-2 h-full shrink-0 max-w-[55%] overflow-x-auto xl:block xl:space-y-2 xl:h-auto xl:max-w-none">
        {screen && <HostTile trackRef={screen} />}
        {cameras.map((t) => (
          <HostTile key={t.participant.identity} trackRef={t} />
        ))}
        {cameras.length === 0 && (
          <p className="text-xs text-zinc-500 font-secondary">Waiting for the host to join…</p>
        )}
      </div>

      <div className="flex-1 min-w-0 h-full overflow-y-auto space-y-2 xl:h-auto xl:overflow-visible xl:mt-3">
        {isOrganizer ? (
          <button
            onClick={() => setRosterOpen((open) => !open)}
            aria-expanded={rosterOpen}
            className="flex items-center gap-1 text-[11px] sm:text-xs text-zinc-400 hover:text-gray-200 font-secondary tracking-wide cursor-pointer"
          >
            {watching}
            <LuChevronDown className={`w-3.5 h-3.5 transition-transform ${rosterOpen ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <p className="text-[11px] sm:text-xs text-zinc-500 font-secondary tracking-wide">{watching}</p>
        )}

        {/* The roster already lists hands and speakers first, with the same
            buttons, so the short lists give way to it while it is open. */}
        {isOrganizer && rosterOpen ? (
          <Roster players={players} renderActions={hostActions} />
        ) : (
          <>
            {speakers.length > 0 && (
              <PlayerList title="Speaking">
                {speakers.map((p) => (
                  <PlayerRow key={p.identity} participant={p}>
                    {isOrganizer ? hostActions(p) : <MicState participant={p} />}
                  </PlayerRow>
                ))}
              </PlayerList>
            )}

            {isOrganizer && hands.length > 0 && (
              <PlayerList title={`Raised hands (${hands.length})`}>
                {hands.map((p) => (
                  <PlayerRow key={p.identity} participant={p}>
                    {hostActions(p)}
                  </PlayerRow>
                ))}
              </PlayerList>
            )}
          </>
        )}

        {isOrganizer ? (
          <>
            <HostControls />
            {quizEnded && <EndCallButton sessionId={sessionId} authToken={authToken} />}
          </>
        ) : (
          <PlayerControls sessionId={sessionId} authToken={authToken} />
        )}
      </div>
    </div>
  );
}


function HostTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const { participant } = trackRef;
  const showVideo = isTrackReference(trackRef) && !trackRef.publication.isMuted;

  return (
    <div className="relative h-full aspect-video shrink-0 xl:h-auto xl:w-full rounded-xl overflow-hidden bg-zinc-900 border border-pink-700/30">
      {showVideo ? (
        <VideoTrack trackRef={trackRef} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className="w-10 h-10 sm:w-14 sm:h-14 rounded-full bg-pink-700/40 flex items-center justify-center text-lg sm:text-2xl font-bold text-pink-200 font-secondary">
            {(participant.name || '?').charAt(0).toUpperCase()}
          </span>
        </div>
      )}
      <span className="absolute bottom-1 left-1 max-w-[90%] flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] sm:text-xs text-gray-200 font-secondary truncate">
        {!participant.isMicrophoneEnabled && <BsMicMute className="shrink-0 text-rose-400" aria-label="Muted" />}
        {participant.name}
      </span>
    </div>
  );
}


/** Raised hands first, then whoever is speaking, then everyone by name. */
const rosterRank = (p: Participant) =>
  p.attributes.hand === 'up' ? 0 : p.attributes.speaker === 'yes' ? 1 : 2;

/**
 * Everyone in the room, for the host. Searchable because at 300 players
 * scrolling for one name is hopeless. Built from the participants the room
 * already tracks, so opening it costs no requests.
 */
function Roster({ players, renderActions }: { players: Participant[]; renderActions: (p: Participant) => ReactNode }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const shown = players
    .filter((p) => !q || (p.name ?? '').toLowerCase().includes(q))
    .sort((a, b) => rosterRank(a) - rosterRank(b) || (a.name ?? '').localeCompare(b.name ?? ''));

  return (
    // Below xl the stage is a short bar, too small for a list, so the roster
    // drops down from it full width; on wide screens it sits in the card.
    <section
      aria-label="Players in the room"
      className="absolute inset-x-0 top-full z-10 p-3 border-b border-pink-700/40 bg-zinc-950/95 backdrop-blur-md xl:static xl:p-0 xl:border-0 xl:bg-transparent xl:backdrop-blur-none"
    >
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search players"
        aria-label="Search players"
        className="w-full mb-1 px-2 py-1 rounded-md bg-zinc-900 border border-zinc-700 focus:border-pink-600/60 outline-none text-xs sm:text-sm text-gray-200 font-secondary placeholder:text-zinc-500"
      />
      <ul className="space-y-1 max-h-[50vh] xl:max-h-60 overflow-y-auto">
        {shown.map((p) => (
          <PlayerRow key={p.identity} participant={p}>
            {renderActions(p)}
          </PlayerRow>
        ))}
        {shown.length === 0 && (
          <li className="text-xs text-zinc-500 font-secondary">
            {q ? 'No player by that name.' : 'No players yet.'}
          </li>
        )}
      </ul>
    </section>
  );
}

function MicState({ participant }: { participant: Participant }) {
  return participant.isMicrophoneEnabled
    ? <BsMic className="shrink-0 text-emerald-400" aria-label="Mic on" />
    : <BsMicMute className="shrink-0 text-zinc-500" aria-label="Mic off" />;
}

/**
 * A host's buttons for one player: mute someone who has the floor, or let
 * anyone else speak, hand raised or not, so a host can call on a player.
 */
function HostRowActions({ participant: p, sessionId, authToken }: { participant: Participant; sessionId: string; authToken: string }) {
  const participantId = p.attributes.participantId!;

  if (p.attributes.speaker === 'yes') {
    return (
      <>
        <MicState participant={p} />
        <HostAction label={`Mute ${p.name}`} onClick={() => stopSpeaking(sessionId, authToken, participantId)}>
          Mute
        </HostAction>
      </>
    );
  }

  return (
    <>
      {p.attributes.hand === 'up' && <FaHand className="shrink-0 text-amber-400" aria-label="Hand raised" />}
      <HostAction label={`Let ${p.name} speak`} onClick={() => allowToSpeak(sessionId, authToken, participantId)}>
        Let speak
      </HostAction>
    </>
  );
}


function PlayerList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] sm:text-xs uppercase tracking-widest text-zinc-400 font-secondary mb-1">{title}</h3>
      <ul className="space-y-1 max-h-40 overflow-y-auto">{children}</ul>
    </section>
  );
}

/** A player as they appear on the stage: their avatar, never a camera. */
function PlayerRow({ participant, children }: { participant: Participant; children: ReactNode }) {
  const id = participant.attributes.participantId ?? participant.identity;

  return (
    <li className="flex items-center gap-2 text-xs sm:text-sm text-gray-300 font-secondary">
      <span className={`w-6 h-6 sm:w-7 sm:h-7 shrink-0 rounded-full bg-linear-to-br ${getAvatarColor(id)} p-px overflow-hidden`}>
        <img src={getAvatar(id)} alt="" aria-hidden="true" className="w-full h-full object-cover rounded-full" />
      </span>
      <span className="truncate flex-1">{participant.name}</span>
      {children}
    </li>
  );
}

/** A host's button on one player's row; `label` names the player for screen readers. */
function HostAction({ label, onClick, children }: { label: string; onClick: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      aria-label={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (err) {
          console.error('[live] host action failed', err);
        } finally {
          setBusy(false);
        }
      }}
      className="shrink-0 px-2 py-0.5 rounded-md border border-pink-600/50 text-pink-300 hover:bg-pink-600/20 text-[11px] sm:text-xs cursor-pointer disabled:opacity-50"
    >
      {children}
    </button>
  );
}


const controlClass = (on: boolean) =>
  `flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border text-xs sm:text-sm font-secondary font-bold cursor-pointer transition ${
    on ? 'border-pink-600/50 bg-pink-600/20 text-pink-200' : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
  }`;

/**
 * Shown to the host on the final screen. Leaving the page ends the call too,
 * after a short grace period; this ends it for everyone at once.
 */
function EndCallButton({ sessionId, authToken }: { sessionId: string; authToken: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          try {
            // The room closing disconnects everyone, this host included,
            // and the stage removes itself.
            await endVideo(sessionId, authToken);
          } catch (err) {
            setProblem(streamError(err, "Couldn't end the video."));
            setBusy(false);
          }
        }}
        className="w-full py-2 rounded-lg border border-red-600/60 bg-red-600/20 hover:bg-red-600/30 text-red-200 text-xs sm:text-sm font-secondary font-bold cursor-pointer disabled:opacity-50"
      >
        {busy ? 'Ending…' : 'End video for everyone'}
      </button>
      {problem && <p role="alert" className="text-[11px] sm:text-xs text-rose-300 font-secondary">{problem}</p>}
    </div>
  );
}

function HostControls() {
  const { localParticipant, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled } = useLocalParticipant();
  // Phones cannot share a screen; do not offer a button that always fails.
  const canShareScreen = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

  return (
    <div className="flex gap-2">
      <button
        className={controlClass(isCameraEnabled)}
        onClick={() => localParticipant.setCameraEnabled(!isCameraEnabled)}
        aria-label={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
      >
        {isCameraEnabled ? <BsCameraVideo /> : <BsCameraVideoOff />}
      </button>
      <button
        className={controlClass(isMicrophoneEnabled)}
        onClick={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
        aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
      >
        {isMicrophoneEnabled ? <BsMic /> : <BsMicMute />}
      </button>
      {canShareScreen && (
        <button
          className={controlClass(isScreenShareEnabled)}
          onClick={() => localParticipant.setScreenShareEnabled(!isScreenShareEnabled)}
          aria-label={isScreenShareEnabled ? 'Stop sharing screen' : 'Share screen'}
        >
          {isScreenShareEnabled ? <MdStopScreenShare /> : <MdScreenShare />}
        </button>
      )}
    </div>
  );
}


function PlayerControls({ sessionId, authToken }: { sessionId: string; authToken: string }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const permissions = useLocalParticipantPermissions();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const handUp = localParticipant.attributes.hand === 'up';
  const maySpeak = Boolean(permissions?.canPublish);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (err) {
      setProblem(streamError(err, failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      {maySpeak ? (
        // Let in by the host: the microphone is theirs to turn on. It is
        // never switched on for them, so nobody goes out live without
        // pressing this.
        <>
          <p className="text-[11px] sm:text-xs text-emerald-300 font-secondary">The host has let you speak.</p>
          <button
            disabled={busy}
            className={`${controlClass(isMicrophoneEnabled)} w-full`}
            onClick={() =>
              run(
                () => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
                'Your microphone is blocked. Allow it in the browser.',
              )
            }
          >
            {isMicrophoneEnabled ? <><BsMic /> Mute</> : <><BsMicMute /> Unmute</>}
          </button>
        </>
      ) : (
        <button
          disabled={busy}
          className={`${controlClass(handUp)} w-full`}
          onClick={() => run(() => setHandRaised(sessionId, authToken, !handUp), "Couldn't reach the host.")}
        >
          <FaHand /> {handUp ? 'Lower hand' : 'Raise hand'}
        </button>
      )}
      {problem && <p role="alert" className="text-[11px] sm:text-xs text-rose-300 font-secondary">{problem}</p>}
    </div>
  );
}

export default LiveStage;
