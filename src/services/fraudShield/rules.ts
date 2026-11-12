export interface OrderRecord {
  internalId: string;
  amount: number;
  currency: string;
  status?: string;
  createdAt?: Date;
}

export interface RuleEvaluationResult {
  triggered: boolean;
  rule: string;
  detail: string;
  weight: number;
}

/**
 * Rule 1: Amount above 2x the buyer's average order amount.
 * Only applies if the buyer has prior transaction history.
 */
export function checkAmountSpike(
  currentOrder: OrderRecord,
  history: OrderRecord[]
): RuleEvaluationResult {
  const ruleName = 'AMOUNT_SPIKE_2X_AVERAGE';
  const weight = 30;

  // Filter valid historical completed or created orders
  const validHistory = history.filter(
    (o) =>
      o.internalId !== currentOrder.internalId &&
      typeof o.amount === 'number' &&
      o.amount > 0 &&
      o.status !== 'REJECTED' &&
      o.status !== 'FAILED'
  );

  if (validHistory.length === 0) {
    return {
      triggered: false,
      rule: ruleName,
      detail: 'No previous order history for average calculation.',
      weight,
    };
  }

  const sum = validHistory.reduce((acc, o) => acc + o.amount, 0);
  const average = sum / validHistory.length;
  const threshold = 2 * average;

  if (currentOrder.amount > threshold) {
    return {
      triggered: true,
      rule: ruleName,
      detail: `Order amount ($${currentOrder.amount.toFixed(
        2
      )}) exceeds 2x the historical average of $${average.toFixed(2)} (threshold: $${threshold.toFixed(
        2
      )}).`,
      weight,
    };
  }

  return {
    triggered: false,
    rule: ruleName,
    detail: `Order amount ($${currentOrder.amount.toFixed(
      2
    )}) is within normal variance of historical average ($${average.toFixed(2)}).`,
    weight,
  };
}

/**
 * Rule 2: More than 3 orders placed in a 10-minute rolling window.
 */
export function checkOrderVelocity(
  currentOrder: OrderRecord,
  history: OrderRecord[],
  referenceTime?: Date
): RuleEvaluationResult {
  const ruleName = 'RAPID_ORDER_VELOCITY';
  const weight = 30;

  const now = referenceTime || currentOrder.createdAt || new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

  const recentOrders = history.filter((o) => {
    if (!o.createdAt || o.internalId === currentOrder.internalId) return false;
    const orderDate = new Date(o.createdAt);
    return orderDate >= tenMinutesAgo && orderDate <= now;
  });

  if (recentOrders.length > 3) {
    return {
      triggered: true,
      rule: ruleName,
      detail: `Velocity alert: ${recentOrders.length} orders placed within the last 10 minutes (maximum expected: 3).`,
      weight,
    };
  }

  return {
    triggered: false,
    rule: ruleName,
    detail: `Order velocity normal: ${recentOrders.length} orders in last 10 minutes.`,
    weight,
  };
}

/**
 * Rule 3: Order placed between 00:00 and 05:00 server time.
 */
export function checkMidnightHours(
  currentOrder: OrderRecord,
  serverTime?: Date
): RuleEvaluationResult {
  const ruleName = 'HIGH_RISK_OVERNIGHT_HOURS';
  const weight = 15;

  const timeToCheck = serverTime || currentOrder.createdAt || new Date();
  const hour = timeToCheck.getHours();

  if (hour >= 0 && hour < 5) {
    return {
      triggered: true,
      rule: ruleName,
      detail: `Transaction initiated during overnight window (${String(hour).padStart(
        2,
        '0'
      )}:00 server time).`,
      weight,
    };
  }

  return {
    triggered: false,
    rule: ruleName,
    detail: `Transaction initiated during standard business hours (${hour}:00 server time).`,
    weight,
  };
}

/**
 * Rule 4: Repeated failed or cancelled orders in the last hour.
 */
export function checkRepeatedFailures(
  currentOrder: OrderRecord,
  history: OrderRecord[],
  referenceTime?: Date
): RuleEvaluationResult {
  const ruleName = 'REPEATED_FAILED_OR_CANCELLED_ORDERS';
  const weight = 25;

  const now = referenceTime || currentOrder.createdAt || new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const failedOrders = history.filter((o) => {
    if (!o.createdAt || o.internalId === currentOrder.internalId) return false;
    const orderDate = new Date(o.createdAt);
    const isRecent = orderDate >= oneHourAgo && orderDate <= now;
    const isFailure =
      o.status === 'FAILED' ||
      o.status === 'VOIDED' ||
      o.status === 'CANCELLED' ||
      o.status === 'REJECTED';
    return isRecent && isFailure;
  });

  if (failedOrders.length >= 2) {
    return {
      triggered: true,
      rule: ruleName,
      detail: `Repeated failures: ${failedOrders.length} failed or cancelled orders detected in the past hour.`,
      weight,
    };
  }

  return {
    triggered: false,
    rule: ruleName,
    detail: `Failure frequency acceptable (${failedOrders.length} recent failures).`,
    weight,
  };
}

/**
 * Rule 5: Currency is not USD.
 */
export function checkNonUsdCurrency(currentOrder: OrderRecord): RuleEvaluationResult {
  const ruleName = 'NON_USD_CURRENCY';
  const weight = 25;

  const currency = (currentOrder.currency || '').toUpperCase();
  if (currency !== 'USD') {
    return {
      triggered: true,
      rule: ruleName,
      detail: `Non-standard transaction currency detected: ${currency} (expected USD).`,
      weight,
    };
  }

  return {
    triggered: false,
    rule: ruleName,
    detail: 'Standard USD currency.',
    weight,
  };
}

