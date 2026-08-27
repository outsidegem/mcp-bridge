export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export enum Role {
  AGENT = 'AGENT',
  OPERATOR = 'OPERATOR',
  ADMIN = 'ADMIN',
  AUDITOR = 'AUDITOR'
}

export enum AuthDecision {
  ALLOW = 'ALLOW',
  DENY = 'DENY',
  REQUIRE_APPROVAL = 'REQUIRE_APPROVAL'
}

export interface AgentIdentity {
  id: string;
  role: Role;
  tenantId: string;
}

export interface LegacyToolDefinition {
  name: string;
  description: string;
  method: HttpMethod;
  targetUrl: string;
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
  credentialRef?: string;
  allowedHeaders?: string[];
  requiredRole?: Role;
  tenantId?: string; // Binds tool to a specific tenant
}

export interface McpExecutionRequest {
  requestId: string;
  agent: AgentIdentity;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface McpExecutionResult {
  success: boolean;
  data?: string;
  error?: string;
  truncated?: boolean;
  latencyMs?: number;
}

export interface ExternalAuthorizationProvider {
  requestApproval(request: McpExecutionRequest, tool: LegacyToolDefinition): Promise<boolean>;
}
