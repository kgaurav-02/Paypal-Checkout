import mongoose, { Document, Model, Schema } from 'mongoose';

export type RiskClassification = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface IRiskReason {
  rule: string;
  detail: string;
  scoreContribution?: number;
}

export interface IRiskAssessment extends Document {
  orderInternalId: string;
  score: number;
  classification: RiskClassification;
  reasons: IRiskReason[];
  recommendedAction: string;
  assessedAt: Date;
}

const RiskReasonSchema = new Schema<IRiskReason>(
  {
    rule: { type: String, required: true },
    detail: { type: String, required: true },
    scoreContribution: { type: Number, default: 0 },
  },
  { _id: false }
);

const RiskAssessmentSchema = new Schema<IRiskAssessment>(
  {
    orderInternalId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    classification: {
      type: String,
      required: true,
      enum: ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'],
      index: true,
    },
    reasons: {
      type: [RiskReasonSchema],
      default: [],
    },
    recommendedAction: {
      type: String,
      required: true,
    },
    assessedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

RiskAssessmentSchema.index({ assessedAt: -1 });

export const RiskAssessmentModel: Model<IRiskAssessment> =
  mongoose.models.RiskAssessment ||
  mongoose.model<IRiskAssessment>('RiskAssessment', RiskAssessmentSchema);

