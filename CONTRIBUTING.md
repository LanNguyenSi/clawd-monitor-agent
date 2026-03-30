# Contributing to clawd-monitor-agent

## Development Setup

```bash
git clone https://github.com/LanNguyenSi/clawd-monitor-agent
cd clawd-monitor-agent
npm install
npm run build
```

## Running Locally

```bash
node dist/cli.js \
  --server https://your-clawd-monitor-domain \
  --token <token> \
  --name "Dev Agent" \
  --gateway http://localhost:18789
```

## Adding a Collector

1. Create `src/collectors/your-collector.ts`
2. Export a `collect*()` async function returning the data
3. Add to `src/collectors/index.ts` and the `AgentSnapshot` type

## Pull Requests

- Branch naming: `feat/<name>` or `fix/<name>`
- Build must pass: `npm run build`
- Keep snapshot size small (avoid large payloads — server may disconnect)
