export interface ApprovalDecision {
  decision: 'allowed' | 'approval_required';
  reason: string;
}

/**
 * Pure function that evaluates whether an order amount can proceed automatically
 * or requires administrative approval based on configured maximum limits.
 *
 * @param amount - Order total amount in USD
 * @param maxAmount - Maximum threshold for automated approval in USD
 */
export function evaluateOrder(amount: number, maxAmount: number): ApprovalDecision {
  // Validate numerical input
  if (typeof amount !== 'number' || isNaN(amount) || !isFinite(amount) || amount <= 0) {
    return {
      decision: 'approval_required',
      reason: 'Order amount is invalid. Transaction must be a positive numerical value.',
    };
  }

  if (typeof maxAmount !== 'number' || isNaN(maxAmount) || !isFinite(maxAmount) || maxAmount <= 0) {
    return {
      decision: 'approval_required',
      reason: 'Configured maximum limit is invalid.',
    };
  }

  // Round to two decimal places for currency comparison
  const roundedAmount = Math.round(amount * 100) / 100;
  const roundedMax = Math.round(maxAmount * 100) / 100;

  if (roundedAmount > roundedMax) {
    return {
      decision: 'approval_required',
      reason: `Order total of $${roundedAmount.toFixed(
        2
      )} exceeds the automated approval limit of $${roundedMax.toFixed(
        2
      )}. Administrative review required.`,
    };
  }

  return {
    decision: 'allowed',
    reason: `Order total of $${roundedAmount.toFixed(
      2
    )} is within the automated approval limit of $${roundedMax.toFixed(2)}.`,
  };
}

