import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IFinancialPolicy extends Document {
  name: string;
  maxAmount: number;
  currency: string;
  requiresApprovalAbove: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FinancialPolicySchema = new Schema<IFinancialPolicy>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    maxAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      default: 'USD',
    },
    requiresApprovalAbove: {
      type: Number,
      required: true,
      min: 0,
    },
    active: {
      type: Boolean,
      required: true,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

FinancialPolicySchema.index({ active: 1 });

export const FinancialPolicyModel: Model<IFinancialPolicy> =
  mongoose.models.FinancialPolicy ||
  mongoose.model<IFinancialPolicy>('FinancialPolicy', FinancialPolicySchema);

