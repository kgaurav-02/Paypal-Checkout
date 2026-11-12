import app from './app';
import { env } from './config/env';
import { connectDB } from './db/connect';
import { financialPolicyRepository } from './repositories/financialPolicyRepository';

const PORT = env.PORT;

async function startServer() {
  try {
    await connectDB();
    await financialPolicyRepository.seedDefaultPolicy(env.MAX_AMOUNT);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Server Startup Failed] ${errorMsg}`);
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`PayPilot Checkout server is running on port ${PORT}`);
    console.log(`Environment: ${env.PAYPAL_ENV}`);
    console.log(`Health check: http://localhost:${PORT}/api/health`);
  });

  return server;
}

const serverPromise = startServer();
export default serverPromise;
