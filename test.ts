import { McpBridge } from './src/index.js';

const bridge = new McpBridge();

console.log("=============================================");
console.log("🌉 TITAN BRIDGE: MCP TRANSLATION ENGINE ONLINE");
console.log("=============================================");

// A messy legacy endpoint (e.g., an old mining rig sensor API)
const legacySensorAPI = {
  url: "http://10.0.0.55/api/v1/get_temp",
  method: "GET" as const,
  requiredParams: ["sensor_id", "auth_token"],
  description: "Fetches the current thermal reading from a legacy drill rig sensor."
};

console.log("\n[BRIDGE]: Ingesting Legacy API Definition...");

// 1. Translate to MCP Schema
const mcpSchema = bridge.generateMcpSchema("drill_rig_thermal_sensor", legacySensorAPI);
console.log("\n✅ [AGENT-READY MCP SCHEMA]:");
console.log(JSON.stringify(mcpSchema, null, 2));

// 2. Simulate Agent Execution
console.log("\n[AGENT]: Decided to use tool. Generating arguments...");
const agentArgs = { sensor_id: "RIG-04", auth_token: "xyz_123" };

const translatedRequest = bridge.formatLegacyRequest(legacySensorAPI, agentArgs);
console.log("✅ [LEGACY REQUEST FORMATTED]:", translatedRequest);

console.log("=============================================");
