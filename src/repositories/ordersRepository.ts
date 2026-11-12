import { IOrder, OrderModel, OrderStatus } from '../models/Order';
import { IWebhookEvent, WebhookEventModel } from '../models/WebhookEvent';

export interface CreateOrderDTO {
  internalId: string;
  paypalOrderId?: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  amount: number;
  currency: string;
  captureId?: string;
}

export interface RecordWebhookEventDTO {
  eventId: string;
  eventType: string;
  receivedAt?: Date;
  processedAt?: Date;
  result?: string;
}

export interface TransactionsSummary {
  month: string;
  countsByStatus: Record<string, number>;
  totalsByStatus: Record<string, number>;
  totalOrders: number;
  totalVolume: number;
}

/**
 * Repository layer for Order and WebhookEvent persistence.
 * Services and routes interface solely with this layer, never with Mongoose directly.
 */
export class OrdersRepository {
  /**
   * Persists a new order or updates existing if already saved (idempotent upsert).
   */
  async saveOrder(data: CreateOrderDTO): Promise<IOrder> {
    const setOnInsert: any = {
      internalId: data.internalId,
      productId: data.productId,
      quantity: data.quantity,
      amount: data.amount,
      currency: data.currency,
    };

    const setFields: any = {
      status: data.status,
    };

    if (data.paypalOrderId) {
      setFields.paypalOrderId = data.paypalOrderId;
    }

    if (data.captureId) {
      setFields.captureId = data.captureId;
    }

    const order = await OrderModel.findOneAndUpdate(
      { internalId: data.internalId },
      {
        $setOnInsert: setOnInsert,
        $set: setFields,
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
      }
    );

    return order;
  }

  /**
   * Finds an order by its internal client-supplied checkout attempt ID.
   */
  async findOrderByInternalId(internalId: string): Promise<IOrder | null> {
    return await OrderModel.findOne({ internalId });
  }

  /**
   * Finds an order by its unique PayPal Order ID.
   */
  async findOrderByPaypalId(paypalOrderId: string): Promise<IOrder | null> {
    return await OrderModel.findOne({ paypalOrderId });
  }

  /**
   * Updates an order's status and optional captureId by PayPal Order ID.
   */
  async updateOrderStatus(
    paypalOrderId: string,
    status: OrderStatus,
    captureId?: string
  ): Promise<IOrder | null> {
    const updateFields: { status: OrderStatus; captureId?: string } = { status };
    if (captureId) {
      updateFields.captureId = captureId;
    }

    return await OrderModel.findOneAndUpdate(
      { paypalOrderId },
      { $set: updateFields },
      { returnDocument: 'after', runValidators: true }
    );
  }

  /**
   * Updates an order's status and optional paypalOrderId by its internal ID.
   */
  async updateOrderByInternalId(
    internalId: string,
    status: OrderStatus,
    paypalOrderId?: string
  ): Promise<IOrder | null> {
    const updateFields: { status: OrderStatus; paypalOrderId?: string } = { status };
    if (paypalOrderId) {
      updateFields.paypalOrderId = paypalOrderId;
    }

    return await OrderModel.findOneAndUpdate(
      { internalId },
      { $set: updateFields },
      { returnDocument: 'after', runValidators: true }
    );
  }

  /**
   * Lists stored orders with optional status filter and limit (max 100).
   */
  async listOrders(filter?: { status?: string }, limit: number = 100): Promise<IOrder[]> {
    const query: Record<string, any> = {};
    if (filter?.status) {
      query.status = filter.status;
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    return await OrderModel.find(query).sort({ createdAt: -1 }).limit(safeLimit);
  }

  /**
   * Computes counts and totals by status for the current month from stored records only.
   */
  async getMonthlySummary(date: Date = new Date()): Promise<TransactionsSummary> {
    const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    const startOfNextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1);

    const orders = await OrderModel.find({
      createdAt: { $gte: startOfMonth, $lt: startOfNextMonth },
    });

    const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const countsByStatus: Record<string, number> = {
      PENDING_APPROVAL: 0,
      APPROVED: 0,
      REJECTED: 0,
      CREATED: 0,
      COMPLETED: 0,
      VOIDED: 0,
      FAILED: 0,
    };
    const totalsByStatus: Record<string, number> = {
      PENDING_APPROVAL: 0,
      APPROVED: 0,
      REJECTED: 0,
      CREATED: 0,
      COMPLETED: 0,
      VOIDED: 0,
      FAILED: 0,
    };

    let totalVolume = 0;

    for (const order of orders) {
      const status = order.status;
      countsByStatus[status] = (countsByStatus[status] || 0) + 1;
      totalsByStatus[status] =
        Math.round(((totalsByStatus[status] || 0) + (order.amount || 0)) * 100) / 100;
      totalVolume = Math.round((totalVolume + (order.amount || 0)) * 100) / 100;
    }

    return {
      month: monthStr,
      countsByStatus,
      totalsByStatus,
      totalOrders: orders.length,
      totalVolume,
    };
  }

  /**
   * Records a webhook event or finds existing event by eventId.
   */
  async recordWebhookEvent(data: RecordWebhookEventDTO): Promise<IWebhookEvent> {
    return await WebhookEventModel.findOneAndUpdate(
      { eventId: data.eventId },
      {
        $setOnInsert: {
          eventId: data.eventId,
          eventType: data.eventType,
          receivedAt: data.receivedAt || new Date(),
          processedAt: data.processedAt,
          result: data.result,
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
      }
    );
  }

  /**
   * Looks up a webhook event by its PayPal eventId.
   */
  async findWebhookEvent(eventId: string): Promise<IWebhookEvent | null> {
    return await WebhookEventModel.findOne({ eventId });
  }

  /**
   * Marks a webhook event as processed with a completion status.
   */
  async markWebhookProcessed(eventId: string, result: string): Promise<IWebhookEvent | null> {
    return await WebhookEventModel.findOneAndUpdate(
      { eventId },
      {
        $set: {
          processedAt: new Date(),
          result,
        },
      },
      { returnDocument: 'after' }
    );
  }
}

// Export singleton instance for dependency injection
export const ordersRepository = new OrdersRepository();
