import { randomUUID } from 'crypto';
import { env } from '../config/env';
import {
  CaptureFailureError,
  OrderNotApprovedError,
  OrderNotFoundError,
  PayPalAuthError,
  PayPalUnavailableError,
} from '../errors/paypalErrors';

const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

/**
 * Standard HTTP request timeout for all outbound calls to PayPal APIs.
 * Prevents hanging connections and ensures prompt client failure recovery.
 */
const REQUEST_TIMEOUT_MS = 10000;

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cachedToken: TokenCache | null = null;

/**
 * Resets the in-memory token cache (used in tests and on 401 recovery).
 */
export function clearTokenCache(): void {
  cachedToken = null;
}

/**
 * Helper to execute a fetch request with timeout handling and sanitized error logs.
 * Guarantees no sensitive credentials or tokens appear in logs.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  contextLabel: string
): Promise<Response> {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      console.error(`[PayPal API ${contextLabel}] Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      throw new PayPalUnavailableError(`PayPal ${contextLabel} service timed out. Please try again.`);
    }
    const errorMsg = err instanceof Error ? err.message : 'Network error';
    console.error(`[PayPal API ${contextLabel}] Network connection failed: ${errorMsg}`);
    throw new PayPalUnavailableError(`Unable to connect to PayPal ${contextLabel} service.`);
  }
}

/**
 * Fetches and caches an in-memory OAuth2 access token from PayPal Sandbox.
 * Uses HTTP Basic Authentication with client credentials.
 * Tokens are cached in-memory until 60 seconds prior to expiration.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const authHeader = `Basic ${Buffer.from(
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64')}`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
  });

  const response = await fetchWithTimeout(
    `${PAYPAL_API_BASE}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    },
    'OAuth Authentication'
  );

  if (!response.ok) {
    console.error(`[PayPal OAuth] Authentication failed with HTTP status ${response.status}`);
    throw new PayPalAuthError(`PayPal authentication failed with status ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  if (!data.access_token) {
    throw new PayPalAuthError('PayPal OAuth response did not contain access_token');
  }

  // Cache token with 60-second safety buffer
  const expiresInMs = (data.expires_in || 3600) * 1000;
  cachedToken = {
    token: data.access_token,
    expiresAt: now + expiresInMs - 60000,
  };

  return cachedToken.token;
}

export interface PayPalCreateOrderParams {
  amount: string; // Formatted as '49.99'
  currency: string;
  description: string;
  requestId?: string;
}

export interface PayPalCreateOrderResult {
  orderId: string;
  status: string;
}

/**
 * Creates an order in PayPal Sandbox using Orders v2 POST /v2/checkout/orders.
 *
 * IDEMPOTENCY NOTE:
 * The 'PayPal-Request-Id' header is passed on all state-mutating requests (create and capture).
 * This guarantees idempotency: in the event of network dropouts or client retries,
 * PayPal will not create duplicate orders or attempt double-captures for the same request ID.
 */
export async function createOrder(
  params: PayPalCreateOrderParams
): Promise<PayPalCreateOrderResult> {
  const token = await getAccessToken();

  // Idempotency key prevents duplicate orders during network retries
  const requestId = params.requestId || randomUUID();

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        description: params.description,
        amount: {
          currency_code: params.currency,
          value: params.amount,
        },
      },
    ],
  };

  const response = await fetchWithTimeout(
    `${PAYPAL_API_BASE}/v2/checkout/orders`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
      },
      body: JSON.stringify(payload),
    },
    'Create Order'
  );

  if (response.status === 401) {
    clearTokenCache();
    throw new PayPalAuthError('PayPal token expired or rejected');
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[PayPal Create Order] Failed with status ${response.status}: ${errorBody}`);
    throw new PayPalUnavailableError(`PayPal create order failed with status ${response.status}`);
  }

  const data = (await response.json()) as { id: string; status: string };
  return {
    orderId: data.id,
    status: data.status,
  };
}

export interface PayPalOrderDetails {
  id: string;
  status: string;
  intent: string;
  purchase_units?: Array<{
    description?: string;
    amount?: {
      currency_code?: string;
      value?: string;
    };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: {
          value: string;
          currency_code: string;
        };
      }>;
    };
  }>;
}

/**
 * Retrieves order details using Orders v2 GET /v2/checkout/orders/{id}.
 */
export async function getOrder(orderId: string): Promise<PayPalOrderDetails> {
  const token = await getAccessToken();

  const response = await fetchWithTimeout(
    `${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
    'Get Order'
  );

  if (response.status === 404) {
    throw new OrderNotFoundError(orderId);
  }

  if (response.status === 401) {
    clearTokenCache();
    throw new PayPalAuthError('PayPal token expired or rejected');
  }

  if (!response.ok) {
    console.error(`[PayPal Get Order] Failed with status ${response.status}`);
    throw new PayPalUnavailableError(`PayPal retrieve order failed with status ${response.status}`);
  }

  return (await response.json()) as PayPalOrderDetails;
}

export interface PayPalCaptureResult {
  id: string;
  status: string;
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: {
          value: string;
          currency_code: string;
        };
      }>;
    };
  }>;
}

/**
 * Captures an order using Orders v2 POST /v2/checkout/orders/{id}/capture.
 *
 * IDEMPOTENCY NOTE:
 * The 'PayPal-Request-Id' header is passed on all state-mutating requests (create and capture).
 * This guarantees idempotency: in the event of network dropouts or client retries,
 * PayPal will not create duplicate orders or attempt double-captures for the same request ID.
 */
export async function captureOrder(
  orderId: string,
  requestId?: string
): Promise<PayPalCaptureResult> {
  const token = await getAccessToken();

  // Idempotency key ensures duplicate capture requests are safely reconciled by PayPal
  const reqId = requestId || randomUUID();

  const response = await fetchWithTimeout(
    `${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': reqId,
      },
      body: JSON.stringify({}),
    },
    'Capture Order'
  );

  if (response.status === 404) {
    throw new OrderNotFoundError(orderId);
  }

  if (response.status === 401) {
    clearTokenCache();
    throw new PayPalAuthError('PayPal token expired or rejected');
  }

  if (response.status === 422) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      name?: string;
      details?: Array<{ issue?: string; description?: string }>;
    };

    const isNotApproved = errorBody.details?.some(
      (detail) => detail.issue === 'ORDER_NOT_APPROVED'
    );
    if (isNotApproved) {
      throw new OrderNotApprovedError(
        'Order cannot be captured because it has not yet been approved by the buyer'
      );
    }

    const detailMsg = errorBody.details?.[0]?.description || 'Capture validation error';
    console.error(`[PayPal Capture] 422 Unprocessable Entity: ${detailMsg}`);
    throw new CaptureFailureError(`PayPal capture unprocessable: ${detailMsg}`);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[PayPal Capture] Failed with status ${response.status}: ${errorBody}`);
    throw new CaptureFailureError(`PayPal capture failed with status ${response.status}`);
  }

  return (await response.json()) as PayPalCaptureResult;
}
