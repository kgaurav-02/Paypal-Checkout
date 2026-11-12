import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { IInvoice, IInvoiceItem, InvoiceModel, InvoiceStatus } from '../models/Invoice';

export const invoiceItemSchema = z.object({
  description: z.string({ required_error: 'description is required' }).trim().min(1, 'description cannot be empty'),
  quantity: z
    .number({ required_error: 'quantity is required' })
    .int('quantity must be an integer')
    .min(1, 'quantity must be at least 1'),
  unitPrice: z
    .number({ required_error: 'unitPrice is required' })
    .min(0, 'unitPrice must be non-negative'),
});

export const createInvoiceSchema = z.object({
  clientId: z.string({ required_error: 'clientId is required' }).min(1, 'clientId cannot be empty'),
  projectId: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1, 'Invoice must contain at least one item'),
  dueDate: z.coerce.date({ required_error: 'dueDate is required' }),
  currency: z.string().default('USD'),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/**
 * Computes the authoritative total amount for an invoice from its line items.
 * Ignores any client-supplied totals to enforce server-side authority.
 */
export function computeInvoiceTotal(items: IInvoiceItem[]): number {
  const sum = items.reduce((acc, item) => acc + item.quantity * item.unitPrice, 0);
  return Math.round(sum * 100) / 100;
}

export class InvoicesRepository {
  /**
   * Creates a new invoice with status DRAFT and server-computed total.
   */
  async createInvoice(data: CreateInvoiceInput, internalId?: string): Promise<IInvoice> {
    const validated = createInvoiceSchema.parse(data);
    const computedTotal = computeInvoiceTotal(validated.items);

    const invoice = new InvoiceModel({
      internalId: internalId || randomUUID(),
      clientId: validated.clientId,
      projectId: validated.projectId,
      items: validated.items,
      total: computedTotal,
      currency: validated.currency || 'USD',
      dueDate: validated.dueDate,
      status: 'DRAFT',
    });

    return await invoice.save();
  }

  /**
   * Finds an invoice by MongoDB ObjectId or internalId.
   */
  async findInvoiceById(idOrInternalId: string): Promise<IInvoice | null> {
    if (mongoose.Types.ObjectId.isValid(idOrInternalId)) {
      const byId = await InvoiceModel.findById(idOrInternalId);
      if (byId) return byId;
    }
    return await InvoiceModel.findOne({ internalId: idOrInternalId });
  }

  /**
   * Lists invoices with optional status and clientId filtering.
   */
  async listInvoices(filter?: {
    status?: InvoiceStatus;
    clientId?: string;
  }): Promise<IInvoice[]> {
    const query: Record<string, any> = {};
    if (filter?.status) {
      query.status = filter.status;
    }
    if (filter?.clientId) {
      query.clientId = filter.clientId;
    }
    return await InvoiceModel.find(query).sort({ createdAt: -1 });
  }

  /**
   * Updates an invoice's status and optional paypalInvoiceId.
   */
  async updateInvoiceStatus(
    idOrInternalId: string,
    status: InvoiceStatus,
    paypalInvoiceId?: string
  ): Promise<IInvoice | null> {
    const query = mongoose.Types.ObjectId.isValid(idOrInternalId)
      ? { $or: [{ _id: idOrInternalId }, { internalId: idOrInternalId }] }
      : { internalId: idOrInternalId };

    const updateFields: { status: InvoiceStatus; paypalInvoiceId?: string } = { status };
    if (paypalInvoiceId) {
      updateFields.paypalInvoiceId = paypalInvoiceId;
    }

    return await InvoiceModel.findOneAndUpdate(
      query,
      { $set: updateFields },
      { returnDocument: 'after', runValidators: true }
    );
  }

  /**
   * Identifies all SENT invoices past their dueDate and marks them OVERDUE.
   * Computed strictly from local stored records.
   */
  async markOverdueInvoices(referenceDate: Date = new Date()): Promise<number> {
    const result = await InvoiceModel.updateMany(
      {
        status: 'SENT',
        dueDate: { $lt: referenceDate },
      },
      {
        $set: { status: 'OVERDUE' },
      }
    );

    return result.modifiedCount;
  }
}

export const invoicesRepository = new InvoicesRepository();

