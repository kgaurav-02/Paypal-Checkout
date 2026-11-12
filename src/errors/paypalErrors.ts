export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class PayPalAuthError extends AppError {
  constructor(message = 'Failed to authenticate with PayPal') {
    super(message, 502, 'PAYPAL_AUTH_ERROR');
  }
}

export class PayPalUnavailableError extends AppError {
  constructor(message = 'PayPal service is currently unavailable') {
    super(message, 503, 'PAYPAL_UNAVAILABLE');
  }
}

export class OrderNotFoundError extends AppError {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`, 404, 'ORDER_NOT_FOUND');
  }
}

export class OrderNotApprovedError extends AppError {
  constructor(message = 'Order is not approved yet for capture') {
    super(message, 409, 'ORDER_NOT_APPROVED');
  }
}

export class CaptureFailureError extends AppError {
  constructor(message = 'Failed to capture PayPal order') {
    super(message, 422, 'CAPTURE_FAILED');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class ProductNotFoundError extends AppError {
  constructor(productId: string) {
    super(`Product not found: ${productId}`, 404, 'PRODUCT_NOT_FOUND');
  }
}

export class AmountLimitExceededError extends AppError {
  constructor(amount: number, maxAmount: number) {
    super(
      `Order amount ($${amount.toFixed(2)}) exceeds maximum allowed transaction limit ($${maxAmount.toFixed(2)})`,
      400,
      'AMOUNT_LIMIT_EXCEEDED'
    );
  }
}

export class OrderRejectedError extends AppError {
  constructor(message = 'Order approval was rejected. Order creation is blocked.') {
    super(message, 403, 'ORDER_REJECTED');
  }
}

export class ApprovalConflictError extends AppError {
  constructor(message = 'Approval request has already been decided.') {
    super(message, 409, 'APPROVAL_CONFLICT');
  }
}
