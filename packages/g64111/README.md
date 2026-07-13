# @jianghu/g64111

`scoreFromState` is the only authoritative G64111 implementation. App, Server, MCP, and offline compatibility tools consume this package; they do not copy its formulas or metadata.

Run the package contract:

```bash
npm ci
npm run typecheck
npm test
```

Check a WorkBuddy offline `score.py` against every static item and total fixture:

```bash
npm run check:score-py -- --score-py /absolute/path/to/_shared/score.py
```

The checker exits non-zero on any missing executable, rejected fractional score, item drift, or total drift. A non-zero result is a compatibility blocker; it must not be reported as a passing M1 gate.
