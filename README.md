# DistributedCache

A production-minded distributed in-memory cache built with **Node.js**, **TypeScript**, and **Express**.

---

## Architecture

```
 ┌─────────────┐     HTTP      ┌──────────────────────┐
 │   Client    │ ────────────► │   API Gateway :3000  │
 └─────────────┘               │  (ConsistentHashRing) │
                                └──────┬───────────────┘
                                       │  Docker bridge (cache-net)
                          ┌────────────┼────────────┐
                          ▼            ▼             ▼
                   ┌────────────┐ ┌────────────┐ ┌────────────┐
                   │cache-node-1│ │cache-node-2│ │cache-node-3│
                   │  :3001     │ │  :3002     │ │  :3003     │
                   │ LRU / LFU  │ │ LRU / LFU  │ │ LRU / LFU  │
                   └────────────┘ └────────────┘ └────────────┘
                    (internal)     (internal)      (internal)
```

### Key properties
- **Consistent hashing** — 100 virtual nodes per physical node, SHA-256, O(log V) lookup.
- **Independent memory** — each node is a separate container with its own `CacheService`.
- **No replication / failover** — if a node is down, its keys return 503/504. No silent rerouting.
- **Single public port** — only the gateway (`:3000`) is published to the host.
- **Node.js built-in fetch** — zero extra HTTP client dependencies.

---

## Milestones

| # | Feature | Status |
|---|---------|--------|
| 1 | REST API (Express, TypeScript) | ✅ |
| 2 | LRU cache (O(1), doubly-linked list) | ✅ |
| 3 | TTL expiration | ✅ |
| 4 | Strategy pattern (LRU + LFU) | ✅ |
| 5 | LFU correctness audit + fixes | ✅ |
| 6 | Consistent Hashing ring | ✅ |
| 7 | Distributed Cache Nodes + API Gateway | ✅ |
| **8** | **Docker + Docker Compose** | **✅** |

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 18 (built-in `fetch`) |
| npm | 8 |
| Docker Engine | 24 |
| Docker Compose | v2 |

---

## Running without Docker (local development)

```bash
npm install

# Terminal 1 — Node 1
NODE_ID=cache-node-1 PORT=3001 npx ts-node src/node-server/nodeServer.ts

# Terminal 2 — Node 2
NODE_ID=cache-node-2 PORT=3002 npx ts-node src/node-server/nodeServer.ts

# Terminal 3 — Node 3
NODE_ID=cache-node-3 PORT=3003 npx ts-node src/node-server/nodeServer.ts

# Terminal 4 — Gateway
npx ts-node src/gateway/gateway.ts
```

---

## Docker Deployment

### Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage build (builder → production, non-root user) |
| `.dockerignore` | Excludes node_modules, dist, tests from build context |
| `docker-compose.yml` | Four-service stack (gateway + 3 nodes) |
| `docker-compose.override.yml` | Dev override — exposes node ports on loopback |
| `.env.example` | Documented env-var overrides |

### Environment variables

#### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_HOST_PORT` | `3000` | Host port the gateway is published on |
| `VIRTUAL_NODES` | `100` | Virtual nodes per physical node |
| `REQUEST_TIMEOUT_MS` | `5000` | Upstream timeout (ms) |

#### Cache nodes (applied to all three)

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_CAPACITY` | `1000` | Max entries per node before eviction |
| `NODE_POLICY` | `LRU` | Eviction policy (`LRU` or `LFU`) |

Copy `.env.example` to `.env` and adjust before running.

---

### Build and start

```bash
# Build image and start all four services in the background
docker compose up --build -d

# Watch logs (Ctrl+C to stop watching — containers keep running)
docker compose logs -f

# Gateway logs only
docker compose logs -f gateway
```

### Service status

```bash
docker compose ps
```

Expected output when healthy:
```
NAME            STATUS                        PORTS
cache-node-1    Up 30 seconds (healthy)
cache-node-2    Up 30 seconds (healthy)
cache-node-3    Up 30 seconds (healthy)
cache-gateway   Up 10 seconds (healthy)       0.0.0.0:3000->3000/tcp
```

### Health checks

```bash
# Gateway health
curl http://localhost:3000/health

# All node statuses (via gateway)
curl http://localhost:3000/nodes

# Individual node health (requires override file — see below)
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

### Testing the API

```bash
# Store a value
curl -X PUT http://localhost:3000/cache \
  -H "Content-Type: application/json" \
  -d '{"key":"user:1","value":"Alice"}'

# Retrieve it
curl http://localhost:3000/cache/user:1

# Store with TTL (60 seconds)
curl -X PUT http://localhost:3000/cache \
  -H "Content-Type: application/json" \
  -d '{"key":"session:abc","value":"token123","ttl":60}'

# Delete
curl -X DELETE http://localhost:3000/cache/user:1
```

### Verifying consistent routing

The gateway always routes a given key to the same node. You can confirm this by checking which node receives a PUT:

```bash
# Store a key
curl -X PUT http://localhost:3000/cache \
  -H "Content-Type: application/json" \
  -d '{"key":"routing-test","value":"hello"}'

# Check which node has it (requires node ports exposed — see override below)
curl http://localhost:3001/cache/routing-test  # 200 or 404
curl http://localhost:3002/cache/routing-test  # 200 or 404
curl http://localhost:3003/cache/routing-test  # 200 or 404
# Exactly one node will return 200; the others return 404.
```

### Exposing node ports for development

Node ports are hidden by default. Use the override file to bind them on loopback:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml up --build -d
```

Nodes are then reachable at `http://localhost:3001`, `http://localhost:3002`, `http://localhost:3003`.

### Verifying unavailable-node behaviour

```bash
# Stop one node
docker compose stop cache-node-2

# Find a key that the ring assigns to cache-node-2, then try to store it.
# The gateway returns 503 — no silent rerouting.
curl -X PUT http://localhost:3000/cache \
  -H "Content-Type: application/json" \
  -d '{"key":"some-key-on-node-2","value":"x"}'
# → HTTP 503  {"success":false,"message":"Node \"cache-node-2\" is unavailable: ..."}

# Confirm other nodes are still serving requests
curl http://localhost:3000/nodes
# → node-2 shows "down", nodes 1 and 3 show "up"

# Restart the stopped node
docker compose start cache-node-2
```

### Configuration overrides

```bash
# Change eviction policy to LFU and increase capacity
NODE_POLICY=LFU NODE_CAPACITY=5000 docker compose up --build -d

# Run gateway on a different host port
GATEWAY_HOST_PORT=8080 docker compose up --build -d
```

### Stop and clean up

```bash
# Stop all containers (data is lost — in-memory only)
docker compose down

# Stop and remove volumes, networks, and the built image
docker compose down --rmi local --volumes
```

### Rebuild a single service

```bash
docker compose up --build -d cache-node-1
```

---

## Running tests

```bash
# Full test suite (no Docker needed)
npm test

# TypeScript type check only
npx tsc --noEmit

# Only unit tests (fast)
npx jest --testPathPatterns="node-app.unit|gateway.unit"

# Only integration tests
npx jest --testPathPatterns="gateway.integration"
```

### Test coverage by file

| File | Coverage |
|------|----------|
| `cache.service.test.ts` | LRU service: 18 tests |
| `lfu.cache.test.ts` | LFU correctness: 31 tests |
| `consistent-hash.test.ts` | Ring + distribution experiments: 50 tests |
| `node-app.unit.test.ts` | Node HTTP endpoints (LRU/LFU): 27 tests |
| `gateway.unit.test.ts` | Gateway routing, failures, TTL: 24 tests |
| `gateway.integration.test.ts` | End-to-end real HTTP stack: 15 tests |

**Total: 165 tests — 165 passing.**

---

## API Reference

All client requests go to the **gateway** (`http://localhost:3000`).

### PUT /cache — store a value

```http
PUT /cache
Content-Type: application/json

{"key": "user:1", "value": "Alice", "ttl": 300}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | ✅ | Cache key |
| `value` | string | ✅ | Value to store |
| `ttl` | number | ❌ | Expiry in seconds (omit for no expiry) |

**200 OK:**
```json
{"success": true, "message": "Cache entry stored successfully."}
```

### GET /cache/:key — retrieve a value

```http
GET /cache/user:1
```

**200 OK:** `{"success": true, "data": {"key": "user:1", "value": "Alice"}}`  
**404:** `{"success": false, "message": "Cache entry not found or expired."}`

### DELETE /cache/:key — remove a value

```http
DELETE /cache/user:1
```

**200 OK:** `{"success": true, "message": "Cache entry deleted successfully."}`  
**404:** `{"success": false, "message": "Cache entry not found."}`

### GET /health — gateway liveness

```json
{
  "status": "ok",
  "role": "gateway",
  "nodes": ["cache-node-1", "cache-node-2", "cache-node-3"],
  "virtualNodesPerPhysical": 100,
  "timestamp": "2026-10-31T05:00:00.000Z"
}
```

### GET /nodes — upstream node health

```json
{
  "gateway": "ok",
  "nodes": [
    {"nodeId": "cache-node-1", "status": "up", "detail": {"size": 42, "policy": "LRU"}},
    {"nodeId": "cache-node-2", "status": "up", "detail": {"size": 38, "policy": "LRU"}},
    {"nodeId": "cache-node-3", "status": "down"}
  ]
}
```

---

## Failure behaviour

| Scenario | Gateway response |
|----------|-----------------|
| Node connection refused | `503 Service Unavailable` |
| Node request timeout | `504 Gateway Timeout` |
| Node returns error | Forwarded as-is (4xx/5xx) |
| Bad request from client | `400 Bad Request` (validated before routing) |

The gateway **never** silently reroutes to a different node.

---

## Consistent hashing — measured results (100,000 keys)

| Node | Keys | % |
|------|------|---|
| cache-node-1 | 34,330 | 34.33% |
| cache-node-2 | 33,975 | 33.98% |
| cache-node-3 | 31,695 | 31.70% |

| Event | Consistent Hashing | Naive Modulo |
|-------|-------------------|-------------|
| Add 4th node | **23.02%** remapped | **75.02%** remapped |
| Remove a node | **31.70%** remapped | **66.69%** remapped |

---

## Known limitations

- **No persistence** — all data is in-memory; restarting a node loses its shard.
- **No replication** — a downed node makes its keys unavailable.
- **No automatic failover** — by design.
- **Single-gateway SPOF** — the gateway is not clustered.
- **No auth/TLS** — add a reverse proxy (nginx/Caddy) in front for production.

---

## Next recommended milestone

**Milestone 9 — Persistence (WAL):** Append-only write-ahead log per node so shards survive restarts, plus Prometheus `/metrics` on each service for `cache_hits`, `cache_misses`, `evictions`, and request latency histograms.
