// First, so the environment is loaded before any module reads it.
import 'dotenv/config';

import { config } from './config.js';
import { createApp } from './app.js';
import { startRoomReaper } from './roomReaper.js';

// Node 22 exits on an unhandled rejection; log it and keep serving.
process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection', reason);
});

startRoomReaper();

createApp().listen(config.port, () => {
    console.log(`[streaming] listening on ${config.port}`);
});
