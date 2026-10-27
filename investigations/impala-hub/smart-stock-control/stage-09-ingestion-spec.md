# Smart Stock Control: Stage 9 Ingestion Specification

## Input and output

The Google workbook supplies two configured tabs: Stock Booking and Stock Reordering. Header aliases and row validation are identical to manual Smart Stock imports. The adapter output is a canonical envelope containing source type, retrieval time, checksum, Booking rows and Reordering rows.

Future Qlik or ERP/ODBC adapters must produce this same envelope and must not write active snapshot tables directly.

## State transitions

```text
enabled source -> running -> validated -> administrator activation -> active
                         \-> no_change
                         \-> failed
```

- `validated` references a newly validated batch created by the same run actor.
- `no_change` references an earlier validated, active or superseded batch with the same checksum and row counts.
- `failed` retains a sanitized diagnostic and never changes the active snapshot.
- A source may have at most one running job.
- A scheduled run uses the configured administrator as its auditable actor.
- Batch creation is idempotent for one run, and batch validation plus run completion is one database transaction.
- Failing or expiring a run rejects only the partial batch uniquely owned by that run.

## Security requirements

1. Google private keys, access tokens, `CRON_SECRET` and the Supabase service-role key remain server-only and must never use a `VITE_` prefix.
2. The workbook remains private and is shared Viewer-only with the dedicated service account.
3. Only active administrators may configure a source or trigger a manual sync.
4. Only the service role may claim/finish runs and use server import wrappers.
5. Stored source JSON must reject unsupported fields so credentials cannot be persisted accidentally.
6. Browser clients cannot insert source, run or audit rows directly.

## Acceptance examples

1. A valid private workbook stages one validated batch with matching row counts while leaving the current active snapshot unchanged.
2. Activating that batch changes both Booking and Reordering to the same version.
3. Repeating the unchanged sync records `no_change` and creates no second batch.
4. A formula, missing Part Number header, duplicate normalized header, invalid number or duplicate Franchise/Part Number pair fails the run and preserves live stock.
5. A concurrent second trigger returns an already-running result and does not create another run.
6. A non-administrator, inactive user, expired session and signed-out request cannot read configuration or start a manual sync.
7. Removing administrator access from the configured scheduled actor prevents the cron from importing.
8. Qlik/ODBC replacement is accepted only when its canonical rows produce the same validation and checksum outcomes for equivalent source data.

