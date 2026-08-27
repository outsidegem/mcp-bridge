import { LegacyToolDefinition, McpExecutionRequest, McpExecutionResult, Role, AuthDecision, ExternalAuthorizationProvider } from './types.js';
import { SecureHttpExecutor } from './executor.js';
import { AuditLogger } from './audit.js';
import { RateLimiter } from './rate-limit.js';
import { NetworkValidator } from './network.js';

export class PolicyEngine {
  public evaluate(request: McpExecutionRequest, tool: LegacyToolDefinition): AuthDecision {
    if (request.agent.role !== Role.AGENT && request.agent.role !== Role.ADMIN) return AuthDecision.DENY;
    if (tool.requiredRole && request.agent.role !== tool.requiredRole) return AuthDecision.DENY;
    if (tool.tenantId && tool.tenantId !== request.agent.tenantId) return AuthDecision.DENY;
    
    if (['POST', 'PUT', 'DELETE'].includes(tool.method)) {
      return AuthDecision.REQUIRE_APPROVAL;
    }
    return AuthDecision.ALLOW;
  }
}

export class McpGateway {
  private registry = new Map<string, LegacyToolDefinition>();

  constructor(
    private executor: SecureHttpExecutor,
    private logger: AuditLogger,
    private policy: PolicyEngine,
    private rateLimiter: RateLimiter,
    private escrowProvider?: ExternalAuthorizationProvider
  ) {}

  public registerTool(tool: LegacyToolDefinition, registrarRole: Role): void {
    if (registrarRole !== Role.ADMIN) {
      throw new Error('Only ADMIN can register tools.');
    }
    this.registry.set(tool.name, tool);
  }

  // Basic Deep Validation Stub (Can be replaced with Ajv/Zod)
  private validateSchema(args: any, schema: any): boolean {
    if (typeof args !== 'object' || args === null) return false;
    // Iterate required keys if defined in a real JSON schema implementation
    return true; 
  }

  public async handleRequest(request: McpExecutionRequest): Promise<McpExecutionResult> {
    const baseLog = { requestId: request.requestId, tenantId: request.agent.tenantId, agentId: request.agent.id, toolName: request.toolName };
    this.logger.log({ type: 'TOOL_INVOKED', ...baseLog, details: 'Agent requested tool execution' });

    const tool = this.registry.get(request.toolName);
    if (!tool) {
      this.logger.log({ type: 'AUTHORIZATION_DENIED', ...baseLog, details: 'Tool not found' });
      return { success: false, error: 'Tool not found.' };
    }

    if (!this.validateSchema(request.arguments, tool.inputSchema)) {
      this.logger.log({ type: 'SECURITY_VIOLATION', ...baseLog, details: 'Schema validation failed' });
      return { success: false, error: 'Malformed arguments.' };
    }

    if (!this.rateLimiter.checkLimit(request.agent.id, tool.name)) {
      this.logger.log({ type: 'SECURITY_VIOLATION', ...baseLog, details: 'Rate limit exceeded' });
      return { success: false, error: 'Rate limit exceeded.' };
    }

    const decision = this.policy.evaluate(request, tool);
    if (decision === AuthDecision.DENY) {
      this.logger.log({ type: 'AUTHORIZATION_DENIED', ...baseLog, details: 'Access denied by policy' });
      return { success: false, error: 'Access denied by policy.' };
    }

    if (decision === AuthDecision.REQUIRE_APPROVAL) {
      this.logger.log({ type: 'APPROVAL_REQUIRED', ...baseLog, details: 'Escrow approval required' });
      if (!this.escrowProvider || !(await this.escrowProvider.requestApproval(request, tool))) {
        this.logger.log({ type: 'AUTHORIZATION_DENIED', ...baseLog, details: 'Human escrow override denied' });
        return { success: false, error: 'Execution denied by human escrow.' };
      }
    }

    try {
      const safeUrl = await NetworkValidator.validateSafeTarget(tool.targetUrl);
      const result = await this.executor.execute({ ...tool, targetUrl: safeUrl }, request.arguments);
      
      this.logger.log({ 
        type: result.success ? 'LEGACY_REQUEST_COMPLETED' : 'LEGACY_REQUEST_FAILED', 
        ...baseLog, 
        target: safeUrl, 
        latencyMs: result.latencyMs, 
        details: result.success ? 'Execution successful' : (result.error || 'Unknown error') 
      });
      return result;
    } catch (e: any) {
      this.logger.log({ type: 'SECURITY_VIOLATION', ...baseLog, details: `Execution aborted: ${e.message}` });
      return { success: false, error: e.message };
    }
  }
}
