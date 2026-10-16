import { LegacyToolDefinition, McpExecutionResult } from './types.js';
import { CredentialProvider } from './credentials.js';
import { NetworkValidator } from './network.js';

const MAX_RESPONSE_SIZE = 2 * 1024 * 1024; // 2MB Limit
const MAX_REDIRECTS = 3;

export class SecureHttpExecutor {
  constructor(private credentialProvider: CredentialProvider) {}

  async execute(tool: LegacyToolDefinition, args: Record<string, unknown>): Promise<McpExecutionResult> {
    const startTime = Date.now();
    let currentUrl: string;
    try {
      currentUrl = await NetworkValidator.validateSafeTarget(tool.targetUrl);
    } catch (e: any) {
      return { success: false, error: e.message, latencyMs: Date.now() - startTime };
    }
    let attempts = 0;
    
    // Resilience: Basic retry loop for idempotent GET requests
    const maxRetries = tool.method === 'GET' ? 2 : 0;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), tool.timeoutMs || 5000);

      try {
        const headers = new Headers();
        headers.set('Content-Type', 'application/json');

        if (tool.credentialRef) {
          const secret = await this.credentialProvider.resolve(tool.credentialRef);
          if (!secret) throw new Error('Authorization failed: Credential not resolved.');
          headers.set('Authorization', `Bearer ${secret}`);
        }

        if (tool.allowedHeaders && args.headers) {
          const inputHeaders = args.headers as Record<string, string>;
          for (const key of tool.allowedHeaders) {
            if (inputHeaders[key]) headers.set(key, String(inputHeaders[key]));
          }
        }

        const requestOptions: RequestInit = {
          method: tool.method,
          headers,
          signal: abortController.signal,
          redirect: 'manual' // Red Team Fix: Do not auto-follow redirects!
        };

        if (tool.method !== 'GET' && tool.method !== 'DELETE') {
          requestOptions.body = JSON.stringify(args.body || args);
        }

        let response = await fetch(currentUrl, requestOptions);

        // SSRF Defense: Manually process redirects and RE-VALIDATE the new IP
        while (response.status >= 300 && response.status < 400 && response.headers.has('location') && attempts < MAX_REDIRECTS) {
          const nextUrl = new URL(response.headers.get('location')!, currentUrl).toString();
          currentUrl = await NetworkValidator.validateSafeTarget(nextUrl);
          attempts++;
          response = await fetch(currentUrl, requestOptions);
        }

        if (attempts >= MAX_REDIRECTS) throw new Error('Security Violation: Too many redirects.');
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const text = await response.text();
        const truncated = text.length > MAX_RESPONSE_SIZE;
        
        return {
          success: true,
          data: truncated ? text.substring(0, MAX_RESPONSE_SIZE) + '\n...[TRUNCATED BY MCP-BRIDGE]' : text,
          truncated,
          latencyMs: Date.now() - startTime
        };
      } catch (error: any) {
        clearTimeout(timeout);
        const isTimeout = error.message === 'This operation was aborted';
        if (isTimeout && retryCount < maxRetries) {
          retryCount++;
          continue; // Exponential backoff can be added here
        }
        return { success: false, error: isTimeout ? 'Request Timeout' : error.message, latencyMs: Date.now() - startTime };
      } finally {
        clearTimeout(timeout);
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  }
}
