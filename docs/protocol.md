# Protocol and lifecycle

The agent opens a single outbound WebSocket to `<server>/api/agents/ws`
(the `--server` URL with `http`/`https` rewritten to `ws`/`wss`). It is a
small JSON message protocol; it is pre-1.0 and may change between minor
versions (see the CHANGELOG note).

- On connect the agent sends an `auth` message (token, agentId, name,
  version, and the gateway URL/token). The server replies `auth_ok` or
  `auth_error`. On `auth_error` the agent stops and does not reconnect.
- After `auth_ok` the agent pushes a `snapshot` message on every interval
  (default 5s); the server may reply `ack`.
- The agent sends a `ping` every 30s and expects a `pong`.
- If the connection drops, the agent reconnects with exponential backoff
  starting at 1s, doubling up to a 60s cap, reset on the next successful
  auth.

## WebSocket lifecycle

The agent maintains a single outbound WebSocket connection with an auth handshake, a periodic snapshot push loop, and a separate heartbeat.

```mermaid
sequenceDiagram
    participant A as "Agent<br/>agent.ts"
    participant S as "Server<br/>/api/agents/ws"
    participant C as "Collectors<br/>src/collectors/index.ts"

    A->>S: WS connect (ws/wss)
    A->>S: auth {token, agentId, name, version, gatewayUrl}

    alt auth_ok
        S-->>A: auth_ok
        Note over A: reconnectDelay reset to 1 s
        loop every intervalMs (default 5 s)
            A->>C: collectSnapshot(config)
            Note over C: Promise.all: collectSessions · collectCronJobs<br/>sync: collectMetrics · collectMemory · collectDocker
            C-->>A: AgentSnapshot
            A->>S: snapshot {data: AgentSnapshot}
            S-->>A: ack
        end
        loop every 30 s
            A->>S: ping
            S-->>A: pong
        end
    else auth_error
        S-->>A: auth_error
        Note over A: stopped = true: no reconnect
    end

    Note over A,S: on disconnect: scheduleReconnect()<br/>1 s base · ×2 · 60 s cap
```
