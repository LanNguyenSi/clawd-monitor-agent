# Contributing to clawd-monitor-agent

## Development Setup

Development needs Node.js 20.19+ or 22.12+ for the test toolchain (CI runs
Node 20 and 22); the published agent runs on Node.js 18+.

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
2. Export a `collect*()` function returning the data (sync or async; see `src/collectors/index.ts` for how the existing ones are wired)
3. Add to `src/collectors/index.ts` and the `AgentSnapshot` type
4. If the collector should be optional, add a `collect.<name>` toggle to `AgentConfig` (`src/types.ts`) and `loadConfig` (`src/config.ts`), and document the key in `docs/cli-reference.md`
5. In [clawd-monitor](https://github.com/LanNguyenSi/clawd-monitor), extend `agentSnapshotSchema` (`src/lib/schemas.ts`) and render the field: the dashboard validates each snapshot against that schema and drops any top-level field it does not list

## Testing

`src/tests/install-sh.test.ts` exercises `install.sh` through real bash.
Most of its cases run only on Linux, since `install.sh` itself refuses to
run on any other OS; on any non-Linux platform those cases report as skipped
(not failed), and the remaining cases only fully exercise `install.sh` on
Linux. CI (`ubuntu-latest`) always runs the full suite.

## Pull Requests

- Branch naming: `feat/<name>` or `fix/<name>`
- CI must pass: `npm run type-check`, `npm run build` and `npm run test:coverage` (coverage thresholds are set in `vitest.config.ts`)
- Keep snapshot size small (avoid large payloads — server may disconnect)
