# @digital-mineral/mcp-bridge 🛡️

**Enterprise MCP Gateway for Legacy Systems.**

## What MCP Bridge Is
A secure, zero-trust perimeter that safely exposes legacy REST, SOAP, and HTTP systems to autonomous AI agents utilizing the Model Context Protocol (MCP). 

## Why It Exists
Autonomous coding agents cannot be blindly trusted with internal network access or raw API credentials. This bridge acts as an isolation layer, translating agent intents into strict, policy-driven legacy requests.

## Security Model
- **Zero-Trust Network:** Employs Node's native DNS resolution to block SSRF, DNS rebinding, and 301-redirect attacks aimed at `localhost`, private subnets, or cloud metadata endpoints.
- **Credential Isolation:** The AI agent **never** receives auth tokens. The Gateway maps `credentialRef` pointers to a secure backend provider before appending headers.
- **Agent Escrow Integration:** Mutating endpoints (POST/PUT/DELETE) automatically halt execution and trigger `ExternalAuthorizationProvider` interfaces for human-in-the-loop approval.
- **Strict Output Constraints:** Implements a hard 2MB payload ceiling to prevent memory exhaustion on edge nodes.

## Multi-Tenancy & Audit
Full RBAC and tenant isolation are enforced at the request level. All operations produce structured, secret-scrubbed audit logs including execution latency and authorization decisions.

## Installation
npm install @digital-mineral/mcp-bridge
