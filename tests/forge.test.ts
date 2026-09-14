import { describe, it, expect, beforeEach } from 'vitest';
import { LocalEscrowAdapter } from '../src/escrow/adapter.js';
import { AuthDecision, Role, McpExecutionRequest, LegacyToolDefinition, AgentIdentity } from '../src/core/types.js';

describe('Escrow Forge Attack', () => {
  it('prevents agent from forging request payload after approval', async () => {
    const adapter = new LocalEscrowAdapter();
    const agent: AgentIdentity = { id: 'agent-1', role: Role.AGENT, tenantId: 'tenant-a' };
    const operator: AgentIdentity = { id: 'operator-1', role: Role.OPERATOR, tenantId: 'tenant-a' };
    
    const request1: McpExecutionRequest = { requestId: 'req-1', agent, toolName: 'test', arguments: { amount: 10 } };
    const request2: McpExecutionRequest = { requestId: 'req-1', agent, toolName: 'test', arguments: { amount: 1000 } };
    
    const tool: LegacyToolDefinition = { name: 'test', targetUrl: 'http://localhost', method: 'POST', inputSchema: {} };
    
    let approvalId;
    try {
      await adapter.requestApproval(request1, tool);
    } catch (e: any) {
      approvalId = e.approvalId;
    }
    
    expect(approvalId).toBeDefined();
    
    // Operator approves
    adapter.approveRequest(approvalId, operator);
    
    // Agent retries with different payload
    const result = await adapter.requestApproval(request2, tool);
    expect(result).toBe(false); // Should reject forged request!
  });
});
