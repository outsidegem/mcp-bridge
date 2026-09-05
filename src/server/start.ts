import { startServer, gateway } from './index.js';
import { Role } from '../core/types.js';

// Register tools for the demo
gateway.registerTool({
  name: 'safeData',
  description: 'Fetch data safely',
  method: 'GET',
  targetUrl: 'https://jsonplaceholder.typicode.com/posts/1',
  inputSchema: {}
}, Role.ADMIN);

gateway.registerTool({
  name: 'tenantBTool',
  description: 'Tenant B restricted tool',
  method: 'GET',
  targetUrl: 'https://jsonplaceholder.typicode.com/posts/2',
  inputSchema: {},
  tenantId: 'tenant-b'
}, Role.ADMIN);

gateway.registerTool({
  name: 'mutateData',
  description: 'Mutate data',
  method: 'POST',
  targetUrl: 'https://jsonplaceholder.typicode.com/posts',
  inputSchema: {}
}, Role.ADMIN);

startServer().catch(console.error);
