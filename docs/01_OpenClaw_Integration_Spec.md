# OpenClaw Integration Spec (for Backend)

Date: 2026-03-02
Status: Verified Against Live Gateway

## 1. Connectivity
- Public URL: `https://47.250.122.37/`
- Transport: WebSocket RPC over TLS
- Auth in deployment currently includes:
  - Nginx Basic Auth at edge
  - OpenClaw gateway token in connect auth payload

## 2. RPC Protocol
Frame format:
```json
{
  "type": "req",
  "id": "unique-id",
  "method": "connect",
  "params": { }
}
```

Server challenge event:
```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "...", "ts": 1772420000000 }
}
```

## 3. Connect Request (Backend Client)
Use `client.id = "gateway-client"` for backend integration.

Example:
```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "gateway-client",
      "version": "1.0.0",
      "platform": "server",
      "mode": "backend",
      "instanceId": "ticket-core"
    },
    "role": "operator",
    "scopes": ["operator.admin"],
    "caps": [],
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "userAgent": "ticket-core",
    "locale": "en-US"
  }
}
```

## 4. Scope Notes
- Minimal verified scope for connect: `operator.admin`
- Some methods require additional scopes (e.g. read operations may require `operator.read`).
- Always handle `INVALID_REQUEST` with explicit logging of missing scope.

## 5. Suggested Backend Adapter Contract
Input to adapter:
```json
{
  "ticket_id": "T-123",
  "title": "Login fails",
  "description": "...",
  "priority": "P2",
  "customer_meta": {},
  "history": []
}
```

Normalized output from adapter:
```json
{
  "action": "auto_resolve | ask_info | escalate",
  "confidence": 0.0,
  "reply": "...",
  "reasoning_summary": "...",
  "evidence": ["..."],
  "risk_flags": []
}
```

## 6. Reliability Requirements
- Connect timeout: 10s
- Method timeout: 30s
- Retry: max 2 (exponential backoff)
- Idempotency key: `ticket_id + ai_run_seq`
- Circuit breaker: open after 5 consecutive failures

## 7. Current Runtime Findings (Server)
- Gateway listens on `127.0.0.1:18789` behind Nginx reverse proxy.
- Live handshake and connect were verified from external client.
- Control UI connect issue was fixed for current environment.

## 8. Security Notes (Important)
Current server config contains temporary setting for operability:
- `gateway.controlUi.dangerouslyDisableDeviceAuth = true`

This is not recommended for production long-term.
Hardening target for production:
- Move to trusted domain + valid TLS cert
- Remove insecure toggle
- Keep strict allowed origins
- Rotate gateway token

## 9. Required Env Vars (for App)
```bash
OPENCLAW_WS_URL=wss://47.250.122.37/
OPENCLAW_BASIC_USER=<from secret manager>
OPENCLAW_BASIC_PASS=<from secret manager>
OPENCLAW_GATEWAY_TOKEN=<from secret manager>
```

Do not hardcode secrets in repo.
