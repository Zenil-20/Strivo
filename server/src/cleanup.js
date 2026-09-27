// Run manually with: npm run cleanup
import mongoose from 'mongoose';
import { loadConfig } from './config.js';
import { cleanupOrphans } from './services/cleanupService.js';
import { connectDb } from './services/db.js';

const config = loadConfig();
await connectDb(config);
try {
  await cleanupOrphans(config);
} finally {
  await mongoose.disconnect();
}
