# Development

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, running locally, adding
a collector, and pull request conventions.

## Testing

```bash
npm test
npm run test:coverage
```

`src/tests/install-sh.test.ts` exercises `install.sh` through real bash.
Most of its cases run only on Linux, since `install.sh` itself refuses to
run on any other OS; on any non-Linux platform those cases report as skipped
(not failed), and the remaining cases only fully exercise `install.sh` on
Linux. CI (`ubuntu-latest`) always runs the full suite.
