import { describe, it, expect, vi } from 'vitest';
import { McpGateway, SecureHttpExecutor, EnvironmentCredentialProvider, LegacyToolDefinition, Role, PolicyEngine, AuditLogger, RateLimiter, NetworkValidator } from '../src/index.js';

describe('Enterprise MCP Gateway - Phase 2 Security', () => {
  const logger = new AuditLogger();
  const executor = new SecureHttpExecutor(new EnvironmentCredentialProvider());
  const policy = new PolicyEngine();
  const rateLimiter = new RateLimiter(2, 60000); // 2 reqs per min

  const mockEscrow = {
    requestApproval: vi.fn().mockResolvedValue(false) // Default to reject
  };

  const gateway = new McpGateway(executor, logger, policy, rateLimiter, mockEscrow);

  const safeGetTool: LegacyToolDefinition = {
    name: 'safeData',
    description: 'Fetch data',
    method: 'GET',
    targetUrl: 'https://jsonplaceholder.typicode.com/posts/1',
    inputSchema: {}
  };

  const mutatingTool: LegacyToolDefinition = {
    name: 'deleteData',
    description: 'Delete data',
    method: 'DELETE',
    targetUrl: 'https://jsonplaceholder.typicode.com/posts/1',
    inputSchema: {}
  };

  it('enforces RBAC: prevents AGENT from registering tools', () => {
    expect(() => gateway.registerTool(safeGetTool, Role.AGENT)).toThrow('Only ADMIN can register tools.');
  });

  it('triggers Agent Escrow on mutating methods (DELETE)', async () => {
    gateway.registerTool(mutatingTool, Role.ADMIN);
    
    const request = { agent: { id: 'agent-1', role: Role.AGENT }, toolName: 'deleteData', arguments: {} };
    const result = await gateway.handleRequest(request);
    
    expect(mockEscrow.requestApproval).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('denied by human escrow');
  });

  it('enforces Rate Limiting', async () => {
    gateway.registerTool(safeGetTool, Role.ADMIN);
    const request = { agent: { id: 'agent-2', role: Role.AGENT }, toolName: 'safeData', arguments: {} };
    
    await gateway.handleRequest(request); // 1
    await gateway.handleRequest(request); // 2
    const result = await gateway.handleRequest(request); // 3 (Blocked)
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limit exceeded.');
  });

  it('blocks SSRF attempts to localhost', async () => {
    await expect(NetworkValidator.validateSafeTarget('https://127.0.0.1/admin')).rejects.toThrow('SSRF Blocked: Target resolves to internal/private IP');
  });

  it('blocks SSRF attempts to Cloud Metadata', async () => {
    await expect(NetworkValidator.validateSafeTarget('https://169.254.169.254/latest/meta-data')).rejects.toThrow('SSRF Blocked: Target resolves to internal/private IP');
  });
});
