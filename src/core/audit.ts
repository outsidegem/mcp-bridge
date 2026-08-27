import { randomUUID } from 'node:crypto';

export type AuditEventType = 
  | 'TOOL_INVOKED' 
  | 'AUTHORIZATION_ALLOWED' 
  | 'AUTHORIZATION_DENIED' 
  | 'APPROVAL_REQUIRED' 
  | 'SECURITY_VIOLATION' 
  | 'LEGACY_REQUEST_FAILED'
  | 'LEGACY_REQUEST_COMPLETED';

export interface AuditEvent {
  eventId: string;
  requestId: string;
  timestamp: number;
  type: AuditEventType;
  tenantId: string;
  agentId: string;
  toolName?: string;
  target?: string;
  latencyMs?: number;
  details: string;
}

export class AuditLogger {
  private logs: AuditEvent[] = [];

  public log(event: Omit<AuditEvent, 'eventId' | 'timestamp'>) {
    const auditEvent: AuditEvent = {
      eventId: randomUUID(),
      timestamp: Date.now(),
      ...event,
      details: this.sanitize(event.details)
    };
    this.logs.push(auditEvent);
  }

  public getLogs(tenantId?: string): AuditEvent[] {
    // Phase 24: Tenant Isolation for Auditors
    return tenantId ? this.logs.filter(l => l.tenantId === tenantId) : [...this.logs];
  }

  private sanitize(input: string): string {
    return input.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
                .replace(/(api_key=)[^\s&]+/gi, '$1[REDACTED]');
  }
}
