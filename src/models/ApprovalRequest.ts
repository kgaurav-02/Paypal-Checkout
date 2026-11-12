import mongoose, { Document, Model, Schema } from 'mongoose';

export type ApprovalRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface IApprovalRequest extends Document {
  internalId: string;
  orderInternalId: string;
  amount: number;
  currency: string;
  reason: string;
  status: ApprovalRequestStatus;
  decidedBy?: string;
  decidedAt?: Date;
  createdAt: Date;
}

const ApprovalRequestSchema = new Schema<IApprovalRequest>(
  {
    internalId: {
      type: String,
      required: true,
      unique: true,
    },
    orderInternalId: {
      type: String,
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'USD',
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['PENDING', 'APPROVED', 'REJECTED'],
      default: 'PENDING',
    },
    decidedBy: {
      type: String,
      default: undefined,
    },
    decidedAt: {
      type: Date,
      default: undefined,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

ApprovalRequestSchema.index({ status: 1 });

export const ApprovalRequestModel: Model<IApprovalRequest> =
  mongoose.models.ApprovalRequest ||
  mongoose.model<IApprovalRequest>('ApprovalRequest', ApprovalRequestSchema);

