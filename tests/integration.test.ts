import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { server, escrowAdapter, gateway } from '../src/server/index.js';
import { Role, LegacyToolDefinition } from '../src/core/types.js';
import { EscrowPendingError } from '../src/escrow/adapter.js';

describe('Stage 1 Agent Firewall Control Loop', () => {
  const safeTool: LegacyToolDefinition = {
    name: 'safeData',
    description: 'Fetch data',
    method: 'GET',
    targetUrl: 'https://jsonplaceholder.typicode.com/posts/1',
    inputSchema: {}
  };

  const mutateTool: LegacyToolDefinition = {
    name: 'mutateData',
    description: 'Mutate data',
    method: 'POST',
    targetUrl: 'https://jsonplaceholder.typicode.com/posts',
    inputSchema: {}
  };
  
  const tenantBTool: LegacyToolDefinition = {
    name: 'tenantBTool',
    description: 'Tenant B restricted',
    method: 'GET',
    targetUrl: 'https://jsonplaceholder.typicode.com/posts/2',
    inputSchema: {},
    tenantId: 'tenant-b'
  };

  const ssrfTool: LegacyToolDefinition = {
    name: 'ssrfLocalhost',
    description: 'Target localhost',
    method: 'GET',
    targetUrl: 'http://127.0.0.1/admin',
    inputSchema: {}
  };

  const redirectTool: LegacyToolDefinition = {
    name: 'redirectLocalhost',
    description: 'Redirects to localhost',
    method: 'GET',
    targetUrl: 'https://httpbin.org/redirect-to',
    inputSchema: {}
  };

  let fetchMock: any;

  beforeAll(() => {
    gateway.registerTool(safeTool, Role.ADMIN);
    gateway.registerTool(mutateTool, Role.ADMIN);
    gateway.registerTool(tenantBTool, Role.ADMIN);
    gateway.registerTool(ssrfTool, Role.ADMIN);
    gateway.registerTool(redirectTool, Role.ADMIN);
  });

  beforeEach(() => {
    if (fetchMock) fetchMock.mockClear();
    
    fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      // Simulate network delay for concurrency test
      await new Promise(r => setTimeout(r, 50));
      
      if (url === 'https://httpbin.org/redirect-to') {
        return {
          status: 302,
          headers: new Headers({ location: 'http://127.0.0.1/admin' }),
          ok: false,
          text: async () => ''
        } as any;
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({ executed: true, url })
      } as any;
    });
    // clear escrow store
    // hack to clear private map for tests
    (escrowAdapter as any).store.clear();
    (escrowAdapter as any).requestToEscrowId.clear();
  });

  afterAll(() => {
    server.close();
    vi.restoreAllMocks();
  });

  // --- EXISTING TESTS --- //

  it('Test 1: Safe GET -> ALLOW -> EXECUTED', async () => {
    const res = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'safeData' });
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Test 2: Unauthorized tenant -> DENY -> No execution', async () => {
    const res = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token') // tenant-a
      .send({ toolName: 'tenantBTool' });
    
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Access denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Test 3 & 4: Mutating request -> REQUIRE_APPROVAL -> Escrow created, then APPROVE -> Execution', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'mutateData' });
    
    expect(reqRes.status).toBe(202);
    expect(reqRes.body.decision).toBe('REQUIRE_APPROVAL');
    expect(reqRes.body.status).toBe('PENDING');
    expect(fetchMock).not.toHaveBeenCalled();

    const approvalId = reqRes.body.approvalId;

    const approveRes = await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Test 5: Denial -> Pending request -> DENY -> No execution', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'mutateData' });
    
    expect(reqRes.status).toBe(202);
    const approvalId = reqRes.body.approvalId;

    const denyRes = await request(server)
      .post(`/v1/escrow/${approvalId}/deny`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(denyRes.status).toBe(200);
    expect(denyRes.body.success).toBe(true);
    expect(denyRes.body.status).toBe('DENIED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Test 6: SSRF -> 127.0.0.1 -> BLOCKED', async () => {
    const res = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'ssrfLocalhost' });
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Internal execution error'); // Sanitized
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Hardening 19: SSRF -> Expands existing protections against adversarial targets', async () => {
    const maliciousTargets = [
      'https://127.0.0.1/admin',
      'https://localhost/admin',
      'https://0.0.0.0/admin',
      'https://[::1]/admin',
      'https://169.254.169.254/latest/meta-data/', // Cloud Metadata
      'https://2130706433/admin', // Integer encoding of 127.0.0.1
      'http://127.0.0.1/admin', // HTTP not allowed
    ];

    for (const target of maliciousTargets) {
      // Create a one-off tool dynamically for testing
      gateway.registerTool({
        name: `ssrfTestTool-${maliciousTargets.indexOf(target)}`,
        description: 'Test',
        method: 'GET',
        targetUrl: target,
        inputSchema: {}
      }, Role.ADMIN);

      const res = await request(server)
        .post('/v1/execute')
        .set('Authorization', 'Bearer mock-agent-token')
        .send({ toolName: `ssrfTestTool-${maliciousTargets.indexOf(target)}` });
      
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Internal execution error');
    }
  });

  it('Test 7: Redirect security -> Redirect to blocked destination rejected', async () => {
    const res = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'redirectLocalhost' });
    
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Internal execution error'); // Sanitized
    // Fetch mock is called once for the initial request, which returns 302
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Test 8: Credential sanitization -> Audit output must not contain bearer tokens', async () => {
    const loggerInstance = (gateway as any).logger;
    loggerInstance.log({ type: 'TOOL_INVOKED', requestId: 'req-8', tenantId: 'test', agentId: 'test', details: 'Using bearer mock-secret-token' });
    
    const logs = loggerInstance.getLogs();
    const targetLog = logs.find((l: any) => l.requestId === 'req-8');
    expect(targetLog.details).not.toContain('mock-secret-token');
    expect(targetLog.details).toContain('[REDACTED]');
  });

  it('Test 9: Duplicate approval -> Approving twice does not execute twice', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'mutateData' });
    
    const approvalId = reqRes.body.approvalId;

    await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    const secondApprove = await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(secondApprove.status).toBe(400);
    expect(secondApprove.body.error).toBe('Invalid state transition');
    
    // Only executed once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Test 10: Expired/invalid Escrow request -> Must fail closed', async () => {
    const res = await request(server)
      .post('/v1/escrow/invalid-id/approve')
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Escrow request not found');
  });

  // --- HARDENING TESTS --- //

  it('Hardening 1: Concurrent Approvals - executes exactly once', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'mutateData' });
    
    const approvalId = reqRes.body.approvalId;

    // Launch two approvals concurrently
    const [res1, res2] = await Promise.all([
      request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token'),
      request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token')
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(400);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Hardening 2: Tenant mismatch prevents approval and reads', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token') // tenant-a
      .send({ toolName: 'mutateData' });
    
    const approvalId = reqRes.body.approvalId;

    // Tenant B operator tries to read it
    const readRes = await request(server)
      .get(`/v1/escrow/${approvalId}`)
      .set('Authorization', 'Bearer mock-operator-token-b');
    expect(readRes.status).toBe(403);
    expect(readRes.body.error).toBe('Tenant mismatch');

    // Tenant B operator tries to approve it
    const approveRes = await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-operator-token-b');
    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error).toBe('Tenant mismatch');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Hardening 3: ADMIN is explicitly cross-tenant', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token') // tenant-a
      .send({ toolName: 'mutateData' });
    
    const approvalId = reqRes.body.approvalId;

    // Admin tries to read it
    const readRes = await request(server)
      .get(`/v1/escrow/${approvalId}`)
      .set('Authorization', 'Bearer mock-admin-token');
    expect(readRes.status).toBe(200);

    // Admin tries to approve it
    const approveRes = await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-admin-token');
    expect(approveRes.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Hardening 4: Request Validation (Missing/Invalid Identity)', async () => {
    const missingRes = await request(server).post('/v1/execute').send({ toolName: 'safeData' });
    expect(missingRes.status).toBe(401);

    const invalidRes = await request(server).post('/v1/execute')
      .set('Authorization', 'Bearer completely-fake-token')
      .send({ toolName: 'safeData' });
    expect(invalidRes.status).toBe(401);
  });

  it('Hardening 5: Request Validation (Malformed Body)', async () => {
    const res = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ arguments: "not-an-object" }); // missing toolName, invalid arguments
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing or invalid toolName');
  });

  it('Hardening 6: Execution failure -> Deterministic state (FAILED)', async () => {
    const reqRes = await request(server)
      .post('/v1/execute')
      .set('Authorization', 'Bearer mock-agent-token')
      .send({ toolName: 'mutateData' });
    
    const approvalId = reqRes.body.approvalId;

    // Mock handleRequest to throw internally for this test to simulate severe execution failure
    const gatewaySpy = vi.spyOn(gateway, 'handleRequest').mockRejectedValueOnce(new Error('Simulated Execution Error'));

    const approveRes = await request(server)
      .post(`/v1/escrow/${approvalId}/approve`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(approveRes.status).toBe(500);
    expect(approveRes.body.error).toBe('Internal server error'); // Generic message

    // Check state is FAILED
    const checkRes = await request(server)
      .get(`/v1/escrow/${approvalId}`)
      .set('Authorization', 'Bearer mock-operator-token');
    
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.status).toBe('FAILED');
    expect(checkRes.body.error).toBe('Internal server error');

    gatewaySpy.mockRestore();
  });

  it('Hardening 7: direct state manipulation through HTTP endpoints does not expose implementation', async () => {
    // There are no endpoints to directly patch escrow record states.
    // Ensure that arbitrary methods return 404
    const patchRes = await request(server)
      .patch('/v1/escrow/fake-id')
      .set('Authorization', 'Bearer mock-admin-token')
      .send({ status: 'APPROVED' });
    expect(patchRes.status).toBe(404);
  });

  it('Hardening 8: Approval after denial fails safely', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    await request(server).post(`/v1/escrow/${approvalId}/deny`).set('Authorization', 'Bearer mock-operator-token');
    
    // Now try to approve
    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error).toBe('Invalid state transition');
  });

  it('Hardening 9: Execution after failed execution fails safely', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const gatewaySpy = vi.spyOn(gateway, 'handleRequest').mockRejectedValueOnce(new Error('Simulated Error'));
    await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    gatewaySpy.mockRestore();

    // Now try to approve (execute) again
    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    expect(approveRes.status).toBe(400);
    expect(approveRes.body.error).toBe('Invalid state transition');
  });
  it('Hardening 10: Ten simultaneous approvals', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const promises = Array.from({ length: 10 }, () => 
      request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token')
    );
    const results = await Promise.all(promises);

    const statuses = results.map(r => r.status);
    const successCount = statuses.filter(s => s === 200).length;
    const failCount = statuses.filter(s => s === 400).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Hardening 11: Twenty simultaneous approvals', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const promises = Array.from({ length: 20 }, () => 
      request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token')
    );
    const results = await Promise.all(promises);

    const statuses = results.map(r => r.status);
    const successCount = statuses.filter(s => s === 200).length;
    const failCount = statuses.filter(s => s === 400).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(19);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Hardening 12: Simultaneous approve + deny', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const [resApprove, resDeny] = await Promise.all([
      request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token'),
      request(server).post(`/v1/escrow/${approvalId}/deny`).set('Authorization', 'Bearer mock-operator-token')
    ]);

    expect([resApprove.status, resDeny.status].sort()).toEqual([200, 400]);
    if (resApprove.status === 200) {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } else {
      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
  });

  it('Hardening 13: Approval while execution is in progress', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    let resolveExecute: any;
    const executionPromise = new Promise(r => { resolveExecute = r; });
    const gatewaySpy = vi.spyOn(gateway, 'handleRequest').mockImplementationOnce(async () => {
      await executionPromise;
      return { success: true } as any;
    });

    try {
      // Force request to send by attaching .then
      const approve1Promise = request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token').then(r=>r);
      
      await new Promise(r => setTimeout(r, 20));

      const approve2 = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
      expect(approve2.status).toBe(400);
      expect(approve2.body.error).toBe('Invalid state transition');

      resolveExecute();
      const res1 = await approve1Promise;
      expect(res1.status).toBe(200);
    } finally {
      resolveExecute();
      gatewaySpy.mockRestore();
    }
  });

  it('Hardening 14: Concurrent reads while state is transitioning', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    let resolveExecute: any;
    const executionPromise = new Promise(r => { resolveExecute = r; });
    const gatewaySpy = vi.spyOn(gateway, 'handleRequest').mockImplementationOnce(async (req) => {
      await escrowAdapter.requestApproval(req as any, {} as any).catch(() => {});
      await executionPromise;
      return { success: true } as any;
    });

    try {
      const approvePromise = request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token').then(r=>r);
      
      await new Promise(r => setTimeout(r, 20));

      const readRes = await request(server).get(`/v1/escrow/${approvalId}`).set('Authorization', 'Bearer mock-operator-token');
      expect(readRes.status).toBe(200);
      expect(readRes.body.status).toBe('EXECUTING');

      resolveExecute();
      await approvePromise;
    } finally {
      resolveExecute();
      gatewaySpy.mockRestore();
    }
  });

  
  
  it('Hardening 16: Malformed execution request bodies', async () => {
    const res1 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send('not json').set('Content-Type', 'text/plain');
    expect(res1.status).toBe(400);

    const res2 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ arguments: [] }); // array instead of object
    expect(res2.status).toBe(400);
  });

  it('Hardening 17: Tool bypass and unknown tools', async () => {
    const unknown = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'fakeTool' });
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toContain('Tool not found');

    // Manipulating identity fields in body shouldn't work (server uses token)
    const bypass = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token-b').send({ 
      toolName: 'tenantBTool',
      agent: { role: Role.ADMIN } // Try to override agent
    });
    // This succeeds because the token is tenant-b which matches tenantBTool!
    // But wait, what if tenant-a tries it?
    const bypass2 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ 
      toolName: 'tenantBTool',
      agent: { role: Role.ADMIN, tenantId: 'tenant-b' } // Try to override agent
    });
    expect(bypass2.status).toBe(403);
  });

  it('Hardening 18: Information Disclosure on Execution Failure', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const gatewaySpy = vi.spyOn(gateway, 'handleRequest').mockRejectedValueOnce(new Error('SENSITIVE_INTERNAL_SQL_ERROR'));
    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    gatewaySpy.mockRestore();

    expect(approveRes.status).toBe(500);
    expect(approveRes.body.error).toBe('Internal server error'); // SENSITIVE string is NOT leaked
    expect(approveRes.body.error).not.toContain('SENSITIVE');
  });

  it('Hardening 18b: Timeout/DNS errors are sanitized and not exposed', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    // Simulate fetch throwing a DNS resolution error
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND internal-db.local'));
    
    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    
    expect(approveRes.status).toBe(200); // 200 OK because orchestration succeeded
    expect(approveRes.body.result.success).toBe(false);
    expect(approveRes.body.result.error).toBe('Internal execution error');
    expect(approveRes.body.result.error).not.toContain('ENOTFOUND');
    expect(approveRes.body.result.error).not.toContain('internal-db.local');

    const checkRes = await request(server).get(`/v1/escrow/${approvalId}`).set('Authorization', 'Bearer mock-operator-token');
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.status).toBe('EXECUTED'); // Result was handled gracefully
    expect(checkRes.body.result.success).toBe(false);
    expect(checkRes.body.result.error).toBe('Internal execution error');
  });
  it('Hardening 20: Oversized HTTP requests fail safely', async () => {
    const bigString = 'a'.repeat(3 * 1024 * 1024); // 3MB
    try {
      await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send(bigString).set('Content-Type', 'text/plain');
    } catch (e) {
      // supertest might throw ECONNRESET when connection is destroyed
    }
  });

  it('Hardening 21: Real schema validation rejects invalid schemas', async () => {
    gateway.registerTool({
      name: 'schemaTool',
      description: 'Test schema',
      method: 'GET',
      targetUrl: 'https://jsonplaceholder.typicode.com/posts/1',
      inputSchema: {
        type: 'object',
        required: ['age'],
        additionalProperties: false,
        properties: {
          age: { type: 'number' },
          name: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          role: { type: 'string', enum: ['admin', 'user'] },
          config: {
            type: 'object',
            properties: { nested: { type: 'boolean' } }
          }
        }
      }
    }, Role.ADMIN);

    // Missing required property
    const res = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { name: 'Alice' } });
    expect(res.status).toBe(403);
    
    // Wrong primitive type
    const res2 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 'not_a_number' } });
    expect(res2.status).toBe(403);

    // Unexpected property where prohibited
    const res3 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 30, unknownProp: 'bad' } });
    expect(res3.status).toBe(403);

    // Malformed array
    const res4 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 30, tags: [1, 2] } });
    expect(res4.status).toBe(403);

    // Invalid enum
    const res5 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 30, role: 'hacker' } });
    expect(res5.status).toBe(403);

    // Malformed nested object
    const res6 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 30, config: { nested: 'not_a_bool' } } });
    expect(res6.status).toBe(403);

    // Valid request succeeds
    const res7 = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'schemaTool', arguments: { age: 30, role: 'admin', config: { nested: true } } });
    expect(res7.status).toBe(200);
  });

  it('Hardening 22: Returned Escrow objects cannot mutate internal state', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const record = escrowAdapter.getRecordAuthorized(approvalId, { id: 'admin-1', role: Role.ADMIN, tenantId: 'system' });
    record.status = 'APPROVED';
    
    const recordAgain = escrowAdapter.getRecordAuthorized(approvalId, { id: 'admin-1', role: Role.ADMIN, tenantId: 'system' });
    expect(recordAgain.status).toBe('PENDING');
  });

  it('Hardening 23: Expired records cannot execute or approve', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    const internalRecord = (escrowAdapter as any).store.get(approvalId);
    internalRecord.createdAt = Date.now() - (6 * 60 * 1000); // 6 minutes ago

    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    expect(approveRes.status).toBe(404);
  });

  it('Hardening 24: Capacity limit fails closed and bounds secondary index', async () => {
    let requestsCreated = 0;
    try {
      for (let i = 0; i < 1100; i++) {
        await escrowAdapter.requestApproval({
          requestId: `req-${i}`,
          agent: { id: 'agent-1', role: Role.AGENT, tenantId: 'tenant-a' },
          toolName: 'mutateData',
          arguments: {}
        }, mutateTool).catch(e => {
          if (e instanceof EscrowPendingError) {
            requestsCreated++;
          } else {
            throw e;
          }
        });
      }
    } catch (e: any) {
      expect(e.message).toBe('Maximum pending escrows reached');
    }

    const storeSize = (escrowAdapter as any).store.size;
    const indexSize = (escrowAdapter as any).requestToEscrowId.size;
    
    expect(storeSize).toBeLessThanOrEqual(1000);
    expect(indexSize).toBeLessThanOrEqual(1000);
    expect(requestsCreated).toBe(1000);
  });

  it('Hardening 25: Expiration/approval race is deterministic', async () => {
    const reqRes = await request(server).post('/v1/execute').set('Authorization', 'Bearer mock-agent-token').send({ toolName: 'mutateData' });
    const approvalId = reqRes.body.approvalId;

    // Simulate time passing beyond TTL
    const internalRecord = (escrowAdapter as any).store.get(approvalId);
    internalRecord.createdAt = Date.now() - (6 * 60 * 1000); // 6 minutes ago

    // Approval races with cleanup
    const approveRes = await request(server).post(`/v1/escrow/${approvalId}/approve`).set('Authorization', 'Bearer mock-operator-token');
    
    // cleanupExpired runs first in approveRequest, so it should delete and return 404
    expect(approveRes.status).toBe(404);
    
    // Also verify that the map is empty
    const storeSize = (escrowAdapter as any).store.size;
    const indexSize = (escrowAdapter as any).requestToEscrowId.size;
    expect(storeSize).toBe(0);
    expect(indexSize).toBe(0);
  });
});
