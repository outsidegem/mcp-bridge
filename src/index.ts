export interface LegacyEndpoint {
  url: string;
  method: 'GET' | 'POST';
  requiredParams: string[];
  description: string;
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
}

export class McpBridge {
  /**
   * Translates a legacy REST/SOAP endpoint into a modern MCP Tool Schema
   * so an AI agent can understand how to call it.
   */
  public generateMcpSchema(toolName: string, endpoint: LegacyEndpoint): McpToolSchema {
    const properties: Record<string, any> = {};
    
    // Map legacy parameters to strict JSON schema properties
    endpoint.requiredParams.forEach(param => {
      properties[param] = { 
        type: "string", 
        description: `Legacy parameter mapping: ${param}` 
      };
    });

    // Ensure toolName is strictly MCP compliant (alphanumeric, hyphens, underscores only)
    const sanitizedName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');

    return {
      name: sanitizedName,
      description: endpoint.description,
      inputSchema: {
        type: "object",
        properties,
        required: endpoint.requiredParams
      }
    };
  }

  /**
   * Formats the final execution payload from the agent back into a legacy request structure
   */
  public formatLegacyRequest(endpoint: LegacyEndpoint, agentArgs: Record<string, any>): string {
    if (endpoint.method === 'GET') {
      const queryParams = new URLSearchParams(agentArgs).toString();
      return `${endpoint.url}?${queryParams}`;
    } else {
      return `POST ${endpoint.url} | PAYLOAD: ${JSON.stringify(agentArgs)}`;
    }
  }
}
