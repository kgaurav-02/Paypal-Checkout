import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IWebhookEvent extends Document {
  eventId: string;
  eventType: string;
  receivedAt: Date;
  processedAt?: Date;
  result?: string;
}

const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: undefined,
    },
    result: {
      type: String,
      default: undefined,
    },
  },
  {
    timestamps: false,
  }
);


export const WebhookEventModel: Model<IWebhookEvent> =
  mongoose.models.WebhookEvent || mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);
