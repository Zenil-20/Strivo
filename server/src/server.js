import os from 'node:os';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Video } from './models/Video.js';
import { cleanupOrphans } from './services/cleanupService.js';
import { connectDb } from './services/db.js';

const config = loadConfig();

await connectDb(config);

// Remove leftovers from crashes (files without a DB record and vice versa).
await cleanupOrphans(config).catch((err) => console.error('[cleanup] failed:', err.message));

const app = createApp(config);
const { conversionQueue } = app.locals;

// Conversions interrupted by a restart start again from the (still intact) original file.
if (config.transcode.enabled) {
  const unfinished = await Video.find({ status: 'processing' }, { _id: 1 }).lean();
  unfinished.forEach((v) => conversionQueue.enqueue(v._id));
  if (unfinished.length) console.log(`[convert] resuming ${unfinished.length} conversion(s)`);
} else {
  console.warn('[convert] ffmpeg not available or TRANSCODE_ENABLED=false: files are kept as uploaded');
}

// The laptop's addresses on the home network: type one of these on the TV / phone.
// Wi-Fi adapters are listed first; others (VirtualBox, VPN, Docker...) are usually not the one.
function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) =>
      (addrs ?? [])
        .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        .map((a) => ({ name, address: a.address, wifi: /wi-?fi|wlan|wireless/i.test(name) })),
    )
    .sort((a, b) => Number(b.wifi) - Number(a.wifi));
}

// Listening on 0.0.0.0 (all interfaces) makes the server reachable from other devices on the Wi-Fi.
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] listening on port ${config.port} (${config.env})`);
  console.log(`[server] on this laptop:        http://localhost:${config.port}`);
  for (const { name, address, wifi } of lanAddresses()) {
    const label = wifi ? 'on your TV / phone:  ' : `other network (${name}):`;
    console.log(`[server] ${label} http://${address}:${config.port}`);
  }
});

// Node's default requestTimeout (5 min) would kill large uploads on slow connections.
// With no size cap an upload may legitimately take hours, so the whole-request timeout
// is disabled. headersTimeout (60 s) still protects against slowloris-style attacks.
server.requestTimeout = 0;
// Hard cap on simultaneous TCP connections as a last line of defence.
server.maxConnections = 500;

async function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close();
  server.closeAllConnections();
  await conversionQueue.stop(); // don't leave ffmpeg running in the background
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
