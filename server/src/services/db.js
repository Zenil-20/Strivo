import dns from 'node:dns';
import mongoose from 'mongoose';

// Never log credentials: "mongodb+srv://user:pass@host" -> "mongodb+srv://***@host"
export const redactUri = (uri) => uri.replace(/\/\/[^@/]*@/, '//***@');

export async function connectDb(config) {
  // mongodb+srv:// URIs need a DNS SRV lookup, which Node does with its own resolver.
  // If the OS points Node at a local DNS proxy that refuses SRV queries
  // (querySrv ECONNREFUSED), set DNS_SERVERS=8.8.8.8,1.1.1.1 in .env.
  if (config.dnsServers.length) dns.setServers(config.dnsServers);

  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
    console.log(`[db] connected to MongoDB at ${redactUri(config.mongoUri)}`);
  } catch (err) {
    console.error(`[db] cannot connect to MongoDB at ${redactUri(config.mongoUri)}: ${err.message}`);
    process.exit(1);
  }
}
