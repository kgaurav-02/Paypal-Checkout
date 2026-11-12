import mongoose, { Document, Model, Schema } from 'mongoose';

export type OrderStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'CREATED'
  | 'COMPLETED'
  | 'VOIDED'
  | 'FAILED';

export interface IOrder extends Document {
  internalId: string;
  paypalOrderId?: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  amount: number;
  currency: string;
  captureId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    internalId: {
      type: String,
      required: true,
      index: true,
    },
    paypalOrderId: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      required: true,
      enum: [
        'PENDING_APPROVAL',
        'APPROVED',
        'REJECTED',
        'CREATED',
        'COMPLETED',
        'VOIDED',
        'FAILED',
      ],
      default: 'CREATED',
    },
    productId: {
      type: String,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      default: 'USD',
    },
    captureId: {
      type: String,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);


export const OrderModel: Model<IOrder> =
  mongoose.models.Order || mongoose.model<IOrder>('Order', OrderSchema);
