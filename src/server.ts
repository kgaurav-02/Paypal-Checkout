import app from './app';
import { env } from './config/env';

const PORT = env.PORT;

const server = app.listen(PORT, () => {
  console.log(`PayPilot Checkout server is running on port ${PORT}`);
  console.log(`Environment: ${env.PAYPAL_ENV}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

export default server;

