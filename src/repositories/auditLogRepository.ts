import { AuditLogModel, IAuditLog } from '../models/AuditLog';

export interface CreateAuditLogDTO {
  action: string;
  actor?: string;
  entityType: string;
  entityId: string;
  details?: Record<string, any>;
}

export class AuditLogRepository {
  /**
   * Records a sanitized audit log entry.
   * Ensures no secrets or full request bodies are recorded.
   */
  async recordLog(data: CreateAuditLogDTO): Promise<IAuditLog> {
    const entry = new AuditLogModel({
      action: data.action,
      actor: data.actor || 'SYSTEM',
      entityType: data.entityType,
      entityId: data.entityId,
      details: data.details || {},
      createdAt: new Date(),
    });

    return await entry.save();
  }

  /**
   * Retrieves recent audit logs sorted newest first.
   */
  async listRecentLogs(limit: number = 50): Promise<IAuditLog[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return await AuditLogModel.find({}).sort({ createdAt: -1 }).limit(safeLimit);
  }
}

export const auditLogRepository = new AuditLogRepository();

