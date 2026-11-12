import mongoose, { Document, Model, Schema } from 'mongoose';

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export interface IInvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface IInvoice extends Document {
  internalId: string;
  clientId: string;
  projectId?: string;
  items: IInvoiceItem[];
  total: number;
  currency: string;
  dueDate: Date;
  status: InvoiceStatus;
  paypalInvoiceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceItemSchema = new Schema<IInvoiceItem>(
  {
    description: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const InvoiceSchema = new Schema<IInvoice>(
  {
    internalId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clientId: {
      type: String,
      required: true,
      index: true,
    },
    projectId: {
      type: String,
      default: undefined,
    },
    items: {
      type: [InvoiceItemSchema],
      required: true,
      validate: [(val: IInvoiceItem[]) => val.length > 0, 'Invoice must have at least one item'],
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'USD',
    },
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'],
      default: 'DRAFT',
    },
    paypalInvoiceId: {
      type: String,
      default: undefined,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes on status and dueDate
InvoiceSchema.index({ status: 1 });
InvoiceSchema.index({ dueDate: 1 });

export const InvoiceModel: Model<IInvoice> =
  mongoose.models.Invoice || mongoose.model<IInvoice>('Invoice', InvoiceSchema);

