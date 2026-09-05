# Stage 1 API Documentation

This document describes the minimal HTTP Orchestrator API for Stage 1 of the Agent Firewall.

## Authentication and Identity

For Stage 1, authentication is mock-based using Bearer tokens. Identity resolution maps a token directly to an `AgentIdentity`.
- `Authorization: Bearer mock-agent-token` -> Role: `AGENT`, Tenant: `tenant-a`
- `Authorization: Bearer mock-operator-token` -> Role: `OPERATOR`, Tenant: `tenant-a`

## Endpoints

### Execute Tool
**`POST /v1/execute`**
- **Description:** Entry point for agents to execute tools. Interacts with the `McpGateway`.
- **Headers:** `Authorization: Bearer <token>`
- **Request Body:**
  ```json
  {
    "toolName": "safeData",
    "arguments": {}
  }
  ```
- **Responses:**
  - `200 OK`: Request was ALLOWED and EXECUTED. Returns execution result.
  - `403 Forbidden`: Request was DENIED.
  - `202 Accepted`: Request requires human approval (REQUIRE_APPROVAL). Returns:
    ```json
    {
      "decision": "REQUIRE_APPROVAL",
      "status": "PENDING",
      "approvalId": "<uuid>",
      "requestId": "<uuid>"
    }
    ```

### List Escrow Requests
**`GET /v1/escrow`**
- **Description:** List all escrow requests. Requires OPERATOR or ADMIN role.
- **Headers:** `Authorization: Bearer <token>`
- **Response Body:** Array of `EscrowRecord` objects (with sensitive details hidden).

### Get Escrow Request
**`GET /v1/escrow/:id`**
- **Description:** Retrieve the status and result of a specific escrow request.
- **Headers:** `Authorization: Bearer <token>`
- **Response Body:** `EscrowRecord` object.

### Approve Escrow Request
**`POST /v1/escrow/:id/approve`**
- **Description:** Approve a pending escrow request and resume its execution. Requires OPERATOR or ADMIN role.
- **Headers:** `Authorization: Bearer <token>`
- **Responses:**
  - `200 OK`: Returns execution result.
  - `400 Bad Request`: If the request is not in the `PENDING` state.

### Deny Escrow Request
**`POST /v1/escrow/:id/deny`**
- **Description:** Deny a pending escrow request. Requires OPERATOR or ADMIN role.
- **Headers:** `Authorization: Bearer <token>`
- **Responses:**
  - `200 OK`: Request was denied and execution is prevented.
  - `400 Bad Request`: If the request is not in the `PENDING` state.

### Health Check
**`GET /health`**
- **Description:** Basic health check endpoint.
- **Response Body:**
  ```json
  {
    "status": "ok",
    "service": "agent-firewall",
    "stage": 1
  }
  ```
