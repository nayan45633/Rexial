const production = process.env.NODE_ENV === 'production';

/**
 * Read a LiveKit credential. The dev defaults are the fixed pair in
 * livekit/livekit.dev.yaml, which is fine on a laptop and a hole anywhere
 * else, so production refuses to start without real values.
 */
function livekitSetting(name: string, devDefault: string): string {
    const value = process.env[name];
    if (value) return value;

    if (production) {
        throw new Error(`${name} must be set in production`);
    }
    return devDefault;
}

export const config = {
    port: Number(process.env.PORT || 7000),

    // Same fallback as http-server and ws-server, so a fresh checkout works
    // without any .env as long as all three agree.
    jwtSecret: process.env.JWT_SECRET || 'secret',

    corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),

    livekit: {
        url: process.env.LIVEKIT_URL || 'http://localhost:7880',
        publicUrl: process.env.LIVEKIT_PUBLIC_URL || 'ws://localhost:7880',
        apiKey: livekitSetting('LIVEKIT_API_KEY', 'devkey'),
        apiSecret: livekitSetting('LIVEKIT_API_SECRET', 'rexial-local-dev-secret-not-for-production'),
    },
};
