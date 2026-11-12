import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IClient extends Document {
  name: string;
  email: string;
  company?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientSchema = new Schema<IClient>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    company: {
      type: String,
      trim: true,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

export const ClientModel: Model<IClient> =
  mongoose.models.Client || mongoose.model<IClient>('Client', ClientSchema);

