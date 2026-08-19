# OpenAI Responses stream fixtures

NDJSON captures of the Responses API streaming endpoint — one SDK `ResponseStreamEvent` per line,
in the order the API sends them. Provider, worker and runtime tests replay them through
`createFakeOpenAIClient`, so the whole model path is exercised without a network call or a key.

## Files

| File                        | Stream it represents                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `text.ndjson`               | Plain answer: three text deltas, the finalised text, `response.completed` with usage |
| `tool-call.ndjson`          | One `run_shell` call: item added, three argument deltas, arguments done, item done   |
| `text-and-tool-call.ndjson` | A short message followed by a `write_file` call in the same response                 |
| `refusal.ndjson`            | A refusal delivered through `response.refusal.delta` / `.done`                       |
| `failed.ndjson`             | `response.failed` carrying `rate_limit_exceeded`                                     |
| `incomplete.ndjson`         | Text cut off by `max_output_tokens`, ending in `response.incomplete`                 |
| `error-event.ndjson`        | A stream-level `error` event                                                         |

## Provenance

The committed files are **synthetic**. They were built from the type declarations of the installed
SDK (`openai@7.5.0`) so every required field is present and every `type` is a member of the shipped
`ResponseStreamEvent` union, then checked by `fixtures.test.ts`. Ids look like real ones
(`resp_…`, `msg_…`, `fc_…`, `call_…`) but identify nothing; no file contains an API key, a real
response id, or personal data.

## Re-recording against the live API

```bash
OPENAI_API_KEY=… pnpm --filter @agent-hangar/core fixtures:record
```

The script refuses to run without a key, never prints it, and writes to
`recorded-<name>.ndjson` — **beside**, never over, the committed fixtures. Diff the recordings
against the committed files, port any shape change by hand, then delete the recordings.

Every recorded line is redacted before it reaches disk: the literal key is removed, and every
credential shape in `SECRET_SHAPE_PATTERNS` is replaced by `[REDACTED]`. Keep it that way — a
fixture is a file in the repository, and the repository never holds a credential.
