# lexware-office-axi – notes for contributors and agents

- TypeScript, ESM, Node ≥ 22. Runtime deps: `axi-sdk-js`, `@toon-format/toon` only.
- Every command lives in the registry (`src/commands/*`, wired in `src/cli.ts`). Help and the skill are generated from it: after changing commands run `npm run build && npm run build:skill`.
- Safety tiers are part of each verb (`read`, `write`, `final`, `depends`). Anything binding, irreversible or outward-facing goes through `gate()` and must stay behind `--confirm`.
- Never retry a write after a 5xx/timeout (only 429, which Lexware guarantees was not performed).
- Tests run against a fake API (`test/helpers.ts`); never against a real account in CI. Live checks only with a Lexware test account (`--profile test`).
- API keys never appear in output, errors or fixtures.
