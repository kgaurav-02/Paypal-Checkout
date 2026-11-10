import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { env } from './config/env';
import { AppError } from './errors/paypalErrors';
import ordersRouter from './routes/orders';

const app = express();

// Parse JSON request bodies
app.use(express.json());

// Parse URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// Serve static assets from public folder
app.use(express.static(path.resolve(__dirname, '../public')));

// Health check endpoint (does not leak credentials)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    paypalEnv: env.PAYPAL_ENV,
  });
});

// Public frontend configuration endpoint (never returns the secret)
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    paypalClientId: env.PAYPAL_CLIENT_ID,
    currency: 'USD',
    maxAmount: env.MAX_AMOUNT,
  });
});

// Mount PayPal Orders v2 routes
app.use('/api/orders', ordersRouter);

// Catch-all 404 handler for undefined API routes
app.use('/api/*', (_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'The requested API route does not exist',
    },
  });
});

// Centralized error handler: guarantees { error: { code, message } } without stack trace
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let statusCode = 500;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An internal server error occurred';

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  }

  // Never return stack traces in responses
  res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
});

export { app };
export default app;
