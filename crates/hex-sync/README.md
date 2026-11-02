# hex-sync

Moves filed Documents from the Outbox into the Archive (ADR 0001). One-way and additive: each
regular file under the Outbox goes to the same relative path in the Archive, and the source is
removed only once a byte-identical copy is there. Nothing in the Archive is ever deleted or
overwritten.

Per file:

- absent in the Archive: copy (temp name, then an exclusive rename), verify by SHA-256, remove the source;
- identical in the Archive (size, then hash): remove the source;
- different in the Archive: copy as `name (n).ext` (lowest free `n`), verify, remove the source.

Skipped: `*.partial` files, files modified less than `min_age_secs` ago, and symlinks (never
followed, logged). Empty Outbox folders are removed afterwards; the Outbox root stays. If either
root is missing, not a folder, or unreadable, or the two overlap, the run aborts before touching
anything. A failed file keeps its source, is logged, and makes the run exit non-zero; the other
files still go through.

## Config

`~/.config/hex/sync.toml` (override with `--config <path>`); unknown keys are rejected:

```toml
outbox = "/srv/hex/outbox"                   # required
archive = "~/Proton Drive/Buchhaltung"       # required
log = "~/Library/Logs/hex/sync.log"          # required, appended to
min_age_secs = 60                            # optional, default 60
interval_secs = 900                          # optional, default 900 (used by the scheduler)
```

Paths must be absolute or start with `~/`.

## Usage

```sh
hex-sync --dry-run   # print the planned actions; nothing on disk changes, not even the log
hex-sync             # same as `hex-sync run`: sync once
```

Every action is appended to the log as one tab-separated line: timestamp, action, Outbox-relative
path, Archive target, outcome. Exit codes: `0` done, `1` some files failed, `2` nothing done
(config error or abort).

## Development

```sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Tests run the built binary against temporary folders (`tests/cli.rs`).
