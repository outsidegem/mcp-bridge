import { ExternalAuthorizationProvider, McpExecutionRequest, LegacyToolDefinition, AgentIdentity, Role } from '../core/types.js';
import { randomUUID } from 'crypto';

export class EscrowPendingError extends Error {
  constructor(public approvalId: string) {
    super('Escrow approval pending');
  }
}

export type EscrowStatus = 'PENDING' | 'APPROVED' | 'EXECUTING' | 'EXECUTED' | 'DENIED' | 'EXPIRED' | 'FAILED';

export interface EscrowRecord {
  approvalId: string;
  requestId: string;
  request: McpExecutionRequest;
  tool: LegacyToolDefinition;
  status: EscrowStatus;
  result?: any;
  error?: string;
  createdAt: number;
}

export class LocalEscrowAdapter implements ExternalAuthorizationProvider {
  private store = new Map<string, EscrowRecord>();
  private requestToEscrowId = new Map<string, string>();
  private readonly MAX_PENDING = 1000;
  private readonly PENDING_TTL_MS = 5 * 60 * 1000;

  private deepCopy<T>(obj: T): T {
    if (obj === undefined) return undefined as any;
    return JSON.parse(JSON.stringify(obj));
  }

  public cleanupExpired() {
    const now = Date.now();
    for (const [id, record] of this.store.entries()) {
      if (now - record.createdAt > this.PENDING_TTL_MS) {
        record.status = 'EXPIRED';
        this.store.delete(id);
        this.requestToEscrowId.delete(record.requestId);
      }
    }
  }

  async requestApproval(request: McpExecutionRequest, tool: LegacyToolDefinition): Promise<boolean> {
    this.cleanupExpired();
    const existingId = this.requestToEscrowId.get(request.requestId);
    
    if (!existingId) {
      if (this.store.size >= this.MAX_PENDING) {
        throw new Error('Maximum pending escrows reached');
      }
      // Create new
      const approvalId = randomUUID();
      this.store.set(approvalId, {
        approvalId,
        requestId: request.requestId,
        request: this.deepCopy(request),
        tool: this.deepCopy(tool),
        status: 'PENDING',
        createdAt: Date.now()
      });
      this.requestToEscrowId.set(request.requestId, approvalId);
      throw new EscrowPendingError(approvalId);
    }

    const record = this.store.get(existingId);
    if (!record) {
       return false; // fail closed
    }

    if (record.status === 'PENDING') {
      throw new EscrowPendingError(existingId);
    }
    
    // Only a freshly APPROVED request can transition to EXECUTING
    if (record.status === 'APPROVED') {
      record.status = 'EXECUTING';
      return true;
    }

    // If EXECUTING, EXECUTED, DENIED, FAILED, EXPIRED -> no new execution
    // To preserve idempotency safely, we just reject duplicate executions
    return false;
  }

  private authorizeAccess(record: EscrowRecord, operator: AgentIdentity) {
    if (operator.role === Role.ADMIN) {
      return; 
    }
    if (operator.tenantId !== record.request.agent.tenantId) {
      throw new Error('Tenant mismatch');
    }
  }

  public getRecordAuthorized(id: string, operator: AgentIdentity): EscrowRecord {
    this.cleanupExpired();
    const record = this.store.get(id);
    if (!record) {
      throw new Error('Not found');
    }
    this.authorizeAccess(record, operator);
    return this.deepCopy(record);
  }

  public getAllRecordsAuthorized(operator: AgentIdentity): EscrowRecord[] {
    this.cleanupExpired();
    const records = Array.from(this.store.values());
    if (operator.role === Role.ADMIN) {
      return records.map(r => this.deepCopy(r));
    }
    return records
      .filter(r => r.request.agent.tenantId === operator.tenantId)
      .map(r => this.deepCopy(r));
  }

  public approveRequest(id: string, operator: AgentIdentity): EscrowRecord {
    this.cleanupExpired();
    const record = this.store.get(id);
    if (!record) {
      throw new Error('Not found');
    }
    this.authorizeAccess(record, operator);

    if (record.status !== 'PENDING') {
      throw new Error('Invalid state transition');
    }

    record.status = 'APPROVED';
    return this.deepCopy(record);
  }

  public denyRequest(id: string, operator: AgentIdentity): EscrowRecord {
    this.cleanupExpired();
    const record = this.store.get(id);
    if (!record) {
      throw new Error('Not found');
    }
    this.authorizeAccess(record, operator);

    if (record.status !== 'PENDING') {
      throw new Error('Invalid state transition');
    }

    record.status = 'DENIED';
    return this.deepCopy(record);
  }

  public completeExecution(id: string, result: any) {
    const record = this.store.get(id);
    if (!record) return;
    if (record.status !== 'EXECUTING' && record.status !== 'APPROVED') {
      throw new Error('Invalid state transition');
    }
    record.status = 'EXECUTED';
    record.result = this.deepCopy(result);
  }

  public failExecution(id: string, error: string) {
    const record = this.store.get(id);
    if (!record) return;
    if (record.status !== 'EXECUTING' && record.status !== 'APPROVED') {
      throw new Error('Invalid state transition');
    }
    record.status = 'FAILED';
    record.error = error;
  }
}

