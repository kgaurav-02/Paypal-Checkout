import {
  ApprovalRequestModel,
  ApprovalRequestStatus,
  IApprovalRequest,
} from '../models/ApprovalRequest';

export interface CreateApprovalRequestDTO {
  internalId: string;
  orderInternalId: string;
  amount: number;
  currency?: string;
  reason: string;
}

export class ApprovalRequestsRepository {
  /**
   * Creates and persists a new approval request with PENDING status.
   */
  async createApprovalRequest(data: CreateApprovalRequestDTO): Promise<IApprovalRequest> {
    const request = new ApprovalRequestModel({
      internalId: data.internalId,
      orderInternalId: data.orderInternalId,
      amount: data.amount,
      currency: data.currency || 'USD',
      reason: data.reason,
      status: 'PENDING',
      createdAt: new Date(),
    });

    return await request.save();
  }

  /**
   * Finds an approval request by its unique internalId.
   */
  async findById(internalId: string): Promise<IApprovalRequest | null> {
    return await ApprovalRequestModel.findOne({ internalId });
  }

  /**
   * Finds an approval request for a given order internal ID.
   */
  async findByOrderInternalId(orderInternalId: string): Promise<IApprovalRequest | null> {
    return await ApprovalRequestModel.findOne({ orderInternalId }).sort({ createdAt: -1 });
  }

  /**
   * Lists approval requests with optional status filtering.
   */
  async listApprovalRequests(filter?: {
    status?: ApprovalRequestStatus;
  }): Promise<IApprovalRequest[]> {
    const query: Record<string, any> = {};
    if (filter?.status) {
      query.status = filter.status;
    }
    return await ApprovalRequestModel.find(query).sort({ createdAt: -1 });
  }

  /**
   * Atomically records a decision on an approval request only if it is currently PENDING.
   * Returns:
   * - { status: 'UPDATED', request: IApprovalRequest } if updated successfully
   * - { status: 'ALREADY_DECIDED', request: IApprovalRequest } if already decided (409 Conflict)
   * - { status: 'NOT_FOUND' } if request does not exist
   */
  async recordDecision(
    internalId: string,
    decision: 'APPROVED' | 'REJECTED',
    decidedBy: string
  ): Promise<
    | { status: 'UPDATED'; request: IApprovalRequest }
    | { status: 'ALREADY_DECIDED'; request: IApprovalRequest }
    | { status: 'NOT_FOUND' }
  > {
    const existing = await ApprovalRequestModel.findOne({ internalId });
    if (!existing) {
      return { status: 'NOT_FOUND' };
    }

    if (existing.status !== 'PENDING') {
      return { status: 'ALREADY_DECIDED', request: existing };
    }

    const updated = await ApprovalRequestModel.findOneAndUpdate(
      { internalId, status: 'PENDING' },
      {
        $set: {
          status: decision,
          decidedBy,
          decidedAt: new Date(),
        },
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      // Race condition handled: another caller updated it first
      const current = await ApprovalRequestModel.findOne({ internalId });
      return { status: 'ALREADY_DECIDED', request: current! };
    }

    return { status: 'UPDATED', request: updated };
  }
}

export const approvalRequestsRepository = new ApprovalRequestsRepository();

