# Local data

All durable app files live under this folder:

```
data/
  config/     SQLite client_config.db (connections, history, settings)
  exports/    Batched CSV/JSON export output
  scripts/    Saved SQL editor tabs (*.sql)
```

## Persist / copy to another machine

1. Stop MySQL Studio Web (`Ctrl+C`).
2. Copy the entire `data/` folder into the project root of the other install.
3. Start with `sh serve.sh` or `npm start`.

If `client_config.db-wal` / `client_config.db-shm` exist under `config/`, copy those too (or stop the server first so SQLite checkpoints into `client_config.db`).

**Security:** `config/` holds DB passwords in plaintext; `scripts/` may contain sensitive SQL. Those paths are gitignored — do not share insecurely.

Folders are auto-created on startup if missing (`0700` for config/scripts, `0755` for data/exports).
