import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LiveStage from './LiveStage';
import * as streamApi from '../../services/streamApi';

// Mock streamApi
vi.mock('../../services/streamApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/streamApi')>();
  return {
    ...actual,
    fetchRoomAccess: vi.fn(),
    setHandRaised: vi.fn(),
    allowToSpeak: vi.fn(),
    stopSpeaking: vi.fn(),
    endVideo: vi.fn(),
  };
});

// State containers for mocked LiveKit hooks
let mockPermissions: { canPublish?: boolean } | undefined = undefined;
let mockLocalParticipant = {
  attributes: {} as Record<string, string>,
  setCameraEnabled: vi.fn().mockResolvedValue(undefined),
  setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
  setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
};
let mockIsMicrophoneEnabled = false;
let mockIsCameraEnabled = false;
let mockIsScreenShareEnabled = false;
let mockParticipants: Participant[] = [];
let mockTracks: TrackReferenceOrPlaceholder[] = [];

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) => <div data-testid="livekit-room">{children}</div>,
  RoomAudioRenderer: () => null,
  StartAudio: () => null,
  VideoTrack: () => <div data-testid="video-track" />,
  isTrackReference: (track: unknown) =>
    Boolean(track && typeof track === 'object' && 'publication' in track && (track as { publication?: unknown }).publication),
  useLocalParticipant: () => ({
    localParticipant: mockLocalParticipant,
    isMicrophoneEnabled: mockIsMicrophoneEnabled,
    isCameraEnabled: mockIsCameraEnabled,
    isScreenShareEnabled: mockIsScreenShareEnabled,
  }),
  useLocalParticipantPermissions: () => mockPermissions,
  useParticipants: () => mockParticipants,
  useTracks: () => mockTracks,
}));

const mockFetchRoomAccess = vi.mocked(streamApi.fetchRoomAccess);
const mockSetHandRaised = vi.mocked(streamApi.setHandRaised);
const mockAllowToSpeak = vi.mocked(streamApi.allowToSpeak);
const mockStopSpeaking = vi.mocked(streamApi.stopSpeaking);
const mockEndVideo = vi.mocked(streamApi.endVideo);

const defaultAccess: streamApi.RoomAccess = {
  url: 'wss://livekit.example.com',
  token: 'mock-livekit-token',
  identity: 'player-1',
  role: 'participant',
};

function renderStage(props: Partial<React.ComponentProps<typeof LiveStage>> = {}) {
  const user = userEvent.setup();
  const defaultProps = {
    sessionId: 'session-123',
    isOrganizer: false,
    authToken: 'auth-token-abc',
    quizEnded: false,
  };

  render(<LiveStage {...defaultProps} {...props} />);
  return { user };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPermissions = { canPublish: false };
  mockLocalParticipant = {
    attributes: {},
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
  };
  mockIsMicrophoneEnabled = false;
  mockIsCameraEnabled = false;
  mockIsScreenShareEnabled = false;
  mockParticipants = [];
  mockTracks = [];

  mockFetchRoomAccess.mockResolvedValue(defaultAccess);
  mockSetHandRaised.mockResolvedValue(undefined);
  mockAllowToSpeak.mockResolvedValue(undefined);
  mockStopSpeaking.mockResolvedValue(undefined);
  mockEndVideo.mockResolvedValue(undefined);
});

describe('LiveStage authentication and connection', () => {
  it('prompts to rejoin if no auth token is provided', () => {
    renderStage({ authToken: null });

    expect(screen.getByText(/rejoin the quiz from the join page to see the host/i)).toBeInTheDocument();
    expect(mockFetchRoomAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('livekit-room')).not.toBeInTheDocument();
  });

  it('fetches room access and mounts LiveKit room on success', async () => {
    renderStage();

    await waitFor(() => {
      expect(mockFetchRoomAccess).toHaveBeenCalledWith('session-123', 'auth-token-abc');
      expect(screen.getByTestId('livekit-room')).toBeInTheDocument();
    });
  });

  it('displays an error alert when room access fails, and allows retry', async () => {
    mockFetchRoomAccess.mockRejectedValueOnce(new Error('Connection failed'));
    const { user } = renderStage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't connect to the live video.");

    mockFetchRoomAccess.mockResolvedValueOnce(defaultAccess);
    const retryBtn = screen.getByRole('button', { name: /try again/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(mockFetchRoomAccess).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('livekit-room')).toBeInTheDocument();
    });
  });

  it('toggles minimization when clicking the collapse button', async () => {
    const { user } = renderStage();

    const toggleBtn = screen.getByRole('button', { name: /hide live video/i });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggleBtn);
    expect(screen.getByRole('button', { name: /show live video/i })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: /show live video/i }));
    expect(screen.getByRole('button', { name: /hide live video/i })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('LiveStage player permissions (speak / cannot-speak split)', () => {
  it('shows the raise hand button (and not microphone button) when player cannot speak', async () => {
    mockPermissions = { canPublish: false };
    mockLocalParticipant.attributes = { hand: 'down' };

    renderStage();

    await screen.findByTestId('livekit-room');

    const raiseHandBtn = screen.getByRole('button', { name: /raise hand/i });
    expect(raiseHandBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unmute|mute microphone/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/the host has let you speak/i)).not.toBeInTheDocument();
  });

  it('calls setHandRaised with true when player clicks raise hand', async () => {
    mockPermissions = { canPublish: false };
    mockLocalParticipant.attributes = {};

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const raiseHandBtn = screen.getByRole('button', { name: /raise hand/i });
    await user.click(raiseHandBtn);

    expect(mockSetHandRaised).toHaveBeenCalledWith('session-123', 'auth-token-abc', true);
  });

  it('shows lower hand and calls setHandRaised with false when hand is already up', async () => {
    mockPermissions = { canPublish: false };
    mockLocalParticipant.attributes = { hand: 'up' };

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const lowerHandBtn = screen.getByRole('button', { name: /lower hand/i });
    expect(lowerHandBtn).toBeInTheDocument();

    await user.click(lowerHandBtn);
    expect(mockSetHandRaised).toHaveBeenCalledWith('session-123', 'auth-token-abc', false);
  });

  it('shows microphone control and notice when player is let in to speak (canPublish: true)', async () => {
    mockPermissions = { canPublish: true };
    mockIsMicrophoneEnabled = false;

    renderStage();
    await screen.findByTestId('livekit-room');

    expect(screen.getByText(/the host has let you speak/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unmute/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /raise hand/i })).not.toBeInTheDocument();
  });

  it('toggles microphone when player clicks unmute/mute', async () => {
    mockPermissions = { canPublish: true };
    mockIsMicrophoneEnabled = false;

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const unmuteBtn = screen.getByRole('button', { name: /unmute/i });
    await user.click(unmuteBtn);

    expect(mockLocalParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });
});

describe('LiveStage error handling during player actions', () => {
  it('displays an error alert when setHandRaised fails', async () => {
    mockPermissions = { canPublish: false };
    mockLocalParticipant.attributes = {};
    mockSetHandRaised.mockRejectedValueOnce({
      response: { data: { error: 'Hand raise rate limited' } },
    });

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const raiseHandBtn = screen.getByRole('button', { name: /raise hand/i });
    await user.click(raiseHandBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hand raise rate limited');
  });

  it('displays default error message when setHandRaised fails with generic error', async () => {
    mockPermissions = { canPublish: false };
    mockLocalParticipant.attributes = {};
    mockSetHandRaised.mockRejectedValueOnce(new Error('Network error'));

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const raiseHandBtn = screen.getByRole('button', { name: /raise hand/i });
    await user.click(raiseHandBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't reach the host.");
  });

  it('displays an error alert when toggling microphone fails', async () => {
    mockPermissions = { canPublish: true };
    mockIsMicrophoneEnabled = false;
    mockLocalParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('Device blocked'));

    const { user } = renderStage();
    await screen.findByTestId('livekit-room');

    const unmuteBtn = screen.getByRole('button', { name: /unmute/i });
    await user.click(unmuteBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your microphone is blocked. Allow it in the browser.');
  });
});

describe('LiveStage host view and moderation', () => {
  it('renders raised hands and allows host to call allowToSpeak', async () => {
    mockParticipants = [
      {
        identity: 'host-id',
        name: 'The Host',
        attributes: { role: 'host' },
        isMicrophoneEnabled: true,
      } as unknown as Participant,
      {
        identity: 'player-alice',
        name: 'Alice',
        attributes: { role: 'participant', participantId: 'p-alice', hand: 'up' },
        isMicrophoneEnabled: false,
      } as unknown as Participant,
    ];

    const { user } = renderStage({ isOrganizer: true });
    await screen.findByTestId('livekit-room');

    expect(screen.getByText(/1 player watching/i)).toBeInTheDocument();
    expect(screen.getByText(/raised hands \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();

    const letSpeakBtn = screen.getByRole('button', { name: /let alice speak/i });
    await user.click(letSpeakBtn);

    expect(mockAllowToSpeak).toHaveBeenCalledWith('session-123', 'auth-token-abc', 'p-alice');
  });

  it('renders active speakers and allows host to call stopSpeaking', async () => {
    mockParticipants = [
      {
        identity: 'host-id',
        name: 'The Host',
        attributes: { role: 'host' },
        isMicrophoneEnabled: true,
      } as unknown as Participant,
      {
        identity: 'player-bob',
        name: 'Bob',
        attributes: { role: 'participant', participantId: 'p-bob', speaker: 'yes' },
        isMicrophoneEnabled: true,
      } as unknown as Participant,
    ];

    const { user } = renderStage({ isOrganizer: true });
    await screen.findByTestId('livekit-room');

    expect(screen.getByText(/speaking/i)).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();

    const muteBtn = screen.getByRole('button', { name: /mute bob/i });
    await user.click(muteBtn);

    expect(mockStopSpeaking).toHaveBeenCalledWith('session-123', 'auth-token-abc', 'p-bob');
  });

  it('shows end call button when quizEnded is true and calls endVideo on click', async () => {
    const { user } = renderStage({ isOrganizer: true, quizEnded: true });
    await screen.findByTestId('livekit-room');

    const endBtn = screen.getByRole('button', { name: /end video for everyone/i });
    expect(endBtn).toBeInTheDocument();

    await user.click(endBtn);
    expect(mockEndVideo).toHaveBeenCalledWith('session-123', 'auth-token-abc');
  });
});
