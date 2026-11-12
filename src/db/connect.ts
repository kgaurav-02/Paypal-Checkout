import dns from 'dns';
import mongoose from 'mongoose';
import { env } from '../config/env';

let isConnected = false;
let memServer: { getUri: () => string; stop: () => Promise<boolean> } | null = null;

/**
 * Connects to MongoDB on application startup.
 * Connects to the provided URI, falling back to an in-memory MongoDB
 * if local MongoDB is unreachable (e.g. during development).
 */
export async function connectDB(uri: string = env.MONGODB_URI): Promise<void> {
  if (isConnected || mongoose.connection.readyState === 1) {
    return;
  }

  // Handle Node.js on Windows SRV DNS resolution issues with Atlas
  if (uri.startsWith('mongodb+srv://')) {
    try {
      dns.setServers(['8.8.8.8', '1.1.1.1']);
    } catch {
      // Continue with system default if custom DNS cannot be set
    }
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    isConnected = true;
    console.log('[Database] Connected successfully to MongoDB.');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[Database Warning] Could not connect to MongoDB at ${uri}: ${errorMsg}`);
    console.log('[Database] Starting in-memory MongoDB instance for development...');

    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      memServer = await MongoMemoryServer.create();
      const memUri = memServer.getUri();
      await mongoose.connect(memUri);
      isConnected = true;
      console.log(`[Database] Connected successfully to in-memory MongoDB (${memUri}).`);
    } catch (memErr: unknown) {
      const memErrMsg = memErr instanceof Error ? memErr.message : String(memErr);
      console.error(`[Database Error] Failed to connect to MongoDB: ${errorMsg}`);
      throw new Error(`Database connection failed: ${errorMsg} (In-memory fallback failed: ${memErrMsg})`);
    }
  }
}

/**
 * Gracefully disconnects from MongoDB (used in tests and shutdown).
 */
export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    isConnected = false;
    console.log('[Database] Disconnected from MongoDB.');
  }
  if (memServer) {
    await memServer.stop();
    memServer = null;
  }
}


