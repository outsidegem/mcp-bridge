import http from 'http';
import { 
  McpGateway, 
  SecureHttpExecutor, 
  EnvironmentCredentialProvider, 
  PolicyEngine, 
  AuditLogger, 
  RateLimiter,
  Role,
  AuthDecision
} from '../index.js';
import { LocalEscrowAdapter, EscrowPendingError } from '../escrow/adapter.js';
import { randomUUID } from 'crypto';

const logger = new AuditLogger();
const executor = new SecureHttpExecutor(new EnvironmentCredentialProvider());
const policy = new PolicyEngine();
const rateLimiter = new RateLimiter(100, 60000);
const escrowAdapter = new LocalEscrowAdapter();

export const gateway = new McpGateway(executor, logger, policy, rateLimiter, escrowAdapter);

const mockTokens: Record<string, any> = {
  'mock-agent-token': { id: 'agent-1', role: Role.AGENT, tenantId: 'tenant-a' },
  'mock-agent-token-b': { id: 'agent-2', role: Role.AGENT, tenantId: 'tenant-b' },
  'mock-operator-token': { id: 'operator-1', role: Role.OPERATOR, tenantId: 'tenant-a' },
  'mock-operator-token-b': { id: 'operator-2', role: Role.OPERATOR, tenantId: 'tenant-b' },
  'mock-admin-token': { id: 'admin-1', role: Role.ADMIN, tenantId: 'system' },
};

function getIdentity(req: http.IncomingMessage) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  return mockTokens[token];
}

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const url = req.url || '';

  const sendJson = (status: number, data: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const getBody = async (): Promise<any> => {
    return new Promise((resolve, reject) => {
      let body = '';
      let isTooLarge = false;
      req.on('data', chunk => {
        if (isTooLarge) return;
        body += chunk.toString();
        if (body.length > 2 * 1024 * 1024) { // 2MB
          isTooLarge = true;
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (isTooLarge) return;
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } 
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
  };

  try {
    if (method === 'GET' && url === '/health') {
      return sendJson(200, { status: 'ok', service: 'agent-firewall', stage: 1 });
    }

    if (method === 'POST' && url === '/v1/execute') {
      const agent = getIdentity(req);
      if (!agent) {
        logger.log({ type: 'AUTHORIZATION_DENIED', tenantId: 'unknown', agentId: 'unknown', details: 'Missing or invalid agent identity' } as any);
        return sendJson(401, { success: false, error: 'Unauthorized' });
      }

      let body;
      try {
        body = await getBody();
      } catch (e: any) {
        return sendJson(400, { success: false, error: 'Malformed request body' });
      }

      if (!body.toolName || typeof body.toolName !== 'string') {
        return sendJson(400, { success: false, error: 'Missing or invalid toolName' });
      }
      
      if (body.arguments !== undefined && (typeof body.arguments !== 'object' || body.arguments === null)) {
        return sendJson(400, { success: false, error: 'Arguments must be an object' });
      }
      
      let requestId = body.requestId;
      if (requestId && typeof requestId !== 'string') {
        return sendJson(400, { success: false, error: 'Invalid requestId structure' });
      }

      const request = {
        requestId: requestId || randomUUID(),
        agent,
        toolName: body.toolName,
        arguments: body.arguments || {}
      };

      try {
        const result = await gateway.handleRequest(request);
        return sendJson(result.success ? 200 : 403, result);
      } catch (e: any) {
        if (e instanceof EscrowPendingError) {
          logger.log({ type: 'ESCROW_CREATED', requestId: request.requestId, tenantId: agent.tenantId, agentId: agent.id, details: `Escrow created: ${e.approvalId}` } as any);
          return sendJson(202, { 
            decision: AuthDecision.REQUIRE_APPROVAL, 
            status: 'PENDING', 
            approvalId: e.approvalId, 
            requestId: request.requestId 
          });
        }
        logger.log({ type: 'SECURITY_VIOLATION', requestId: request.requestId, tenantId: agent.tenantId, agentId: agent.id, details: 'Internal execution error' } as any);
        return sendJson(500, { success: false, error: 'Internal server error' });
      }
    }

    if (method === 'GET' && url === '/v1/escrow') {
      const operator = getIdentity(req);
      if (!operator || (operator.role !== Role.OPERATOR && operator.role !== Role.ADMIN)) {
        return sendJson(401, { success: false, error: 'Unauthorized' });
      }
      const records = escrowAdapter.getAllRecordsAuthorized(operator).map(r => ({...r, request: undefined, tool: undefined}));
      return sendJson(200, records);
    }

    const escrowIdMatch = url.match(/^\/v1\/escrow\/([a-zA-Z0-9-]+)(\/approve|\/deny)?$/);
    if (escrowIdMatch) {
      const id = escrowIdMatch[1];
      const action = escrowIdMatch[2]; // undefined, /approve, or /deny
      
      const operator = getIdentity(req);
      if (!operator || (operator.role !== Role.OPERATOR && operator.role !== Role.ADMIN)) {
        return sendJson(401, { success: false, error: 'Unauthorized' });
      }

      if (method === 'GET' && !action) {
        try {
          const record = escrowAdapter.getRecordAuthorized(id, operator);
          return sendJson(200, { ...record, request: undefined, tool: undefined });
        } catch (e: any) {
          if (e.message === 'Not found') return sendJson(404, { success: false, error: 'Escrow request not found' });
          if (e.message === 'Tenant mismatch') return sendJson(403, { success: false, error: 'Tenant mismatch' });
          return sendJson(500, { success: false, error: 'Internal server error' });
        }
      }

      if (method === 'POST' && action === '/approve') {
        let record;
        try {
          record = escrowAdapter.approveRequest(id, operator);
        } catch (e: any) {
          if (e.message === 'Not found') return sendJson(404, { success: false, error: 'Escrow request not found' });
          if (e.message === 'Tenant mismatch') return sendJson(403, { success: false, error: 'Tenant mismatch' });
          if (e.message === 'Invalid state transition') return sendJson(400, { success: false, error: 'Invalid state transition' });
          return sendJson(500, { success: false, error: 'Internal server error' });
        }

        logger.log({ type: 'ESCROW_APPROVED', requestId: record.requestId, tenantId: operator.tenantId, agentId: operator.id, details: `Escrow ${id} approved by ${operator.id}` } as any);

        // Resume execution
        try {
          const result = await gateway.handleRequest(record.request);
          escrowAdapter.completeExecution(id, result);
          logger.log({ type: 'EXECUTION_COMPLETED', requestId: record.requestId, tenantId: operator.tenantId, agentId: operator.id, details: `Execution completed: ${result.success}` } as any);
          return sendJson(200, { success: true, result });
        } catch (e: any) {
          escrowAdapter.failExecution(id, 'Internal server error');
          return sendJson(500, { success: false, error: 'Internal server error' });
        }
      }

      if (method === 'POST' && action === '/deny') {
        let record;
        try {
          record = escrowAdapter.denyRequest(id, operator);
        } catch (e: any) {
          if (e.message === 'Not found') return sendJson(404, { success: false, error: 'Escrow request not found' });
          if (e.message === 'Tenant mismatch') return sendJson(403, { success: false, error: 'Tenant mismatch' });
          if (e.message === 'Invalid state transition') return sendJson(400, { success: false, error: 'Invalid state transition' });
          return sendJson(500, { success: false, error: 'Internal server error' });
        }

        logger.log({ type: 'ESCROW_DENIED', requestId: record.requestId, tenantId: operator.tenantId, agentId: operator.id, details: `Escrow ${id} denied by ${operator.id}` } as any);
        return sendJson(200, { success: true, status: 'DENIED' });
      }
    }

    return sendJson(404, { error: 'Not found' });
  } catch (e: any) {
    console.error('Unhandled Orchestrator Exception', e);
    return sendJson(500, { success: false, error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
export const startServer = () => {
  return new Promise<void>((resolve) => {
    server.listen(PORT, () => {
      console.log(`Stage 1 Agent Firewall running on port ${PORT}`);
      resolve();
    });
  });
};

export const stopServer = () => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

export { server, escrowAdapter };
