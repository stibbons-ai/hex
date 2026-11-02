# hex-sync

Moves filed Documents from the Outbox into the Archive (ADR 0001). One-way and additive: each
regular file under the Outbox goes to the same relative path in the Archive, and the source is
removed only once a byte-identical copy is there. Nothing in the Archive is ever deleted or
overwritten.

Per file:

- the source is first renamed to a claim, `.hex-sync.<name>` in its own folder, so a file that
  replaces it while the sync works on it is left alone;
- absent in the Archive: copy (to `.hex-sync-<n>.tmp`, fsync, exclusive rename), verify by
  SHA-256, remove the claim;
- identical in the Archive (size, then hash), at the same path or at a `name (n).ext` up to
  the first free `n`: remove the claim;
- different in the Archive: copy as `name (n).ext` (lowest free `n`; `name (n)` without an
  extension), verify, remove the claim.

Before a claim is removed, the Archive folder holding the copy is fsynced (and so is the
parent of every Archive folder the run created), and the claim is re-hashed. On any failure
the claim is renamed back (to `name (n).ext` in the Outbox if the name was taken meanwhile),
and the run exits `1`. A run starts by restoring claims left by an interrupted run. Names
longer than 245 bytes can't be claimed, so they fail on every run and stay in the Outbox.

Reserved names: an Outbox file named `.hex-sync.<name>` is treated as a claim and restored to
`<name>` before it is archived. In the Archive, `.hex-sync-<n>.tmp` names are used for temp
files. A file already there under such a name (left by a crash, another run's temp, or a
Document that happens to have that name) is logged as `stale-temp` when a copy into that
folder meets it, and is never deleted. Check it is not a Document before removing it by
hand.

Skipped:

- `*.partial` files and files modified less than `min_age_secs` ago;
- OS metadata: `.DS_Store`, `Thumbs.db` and AppleDouble `._*` files (only those that start
  with the AppleDouble magic number, so a Document named `._x.pdf` still moves); skipped
  silently and, like `*.partial` files, they keep their folder in the Outbox;
- files with a future or unreadable mtime, whatever `min_age_secs` says (logged as
  `skip-bad-mtime`);
- symlinks (never followed; logged as `skip-symlink`);
- sockets, FIFOs and devices (logged as `skip-special`).

A file whose Archive folder is a symlink fails rather than being followed, and so does a source
that turns out to be the Archive file itself (a hard link). Empty Outbox folders are removed
afterwards; the Outbox root stays.

The run aborts before touching anything (exit `2`) in these cases:

- either root is missing, not a folder, or unreadable;
- the roots are the same folder or one contains the other, compared by device and inode so that
  symlinks, firmlinks and bind mounts can't hide it;
- the log lies inside either root, or is a symlink.

An abort never creates a folder: it is appended to the log only if the log's folder already
exists (and the log is neither inside a root nor a symlink), otherwise it goes to stderr only.
So a log under a missing root, such as an unmounted drive, can't recreate that root.

## Config

`~/.config/hex/sync.toml` (override with `--config <path>`); unknown keys are rejected:

```toml
outbox = "/srv/hex/outbox"                   # required
archive = "~/Proton Drive/Buchhaltung"       # required
log = "~/Library/Logs/hex/sync.log"          # required, appended to; outside both roots, no symlink
min_age_secs = 60                            # optional, default 60
interval_secs = 900                          # optional, default 900, > 0 (seconds between scheduled runs)
```

Paths must be absolute or start with `~/`.

## Usage

```sh
hex-sync --dry-run   # print the planned actions; nothing on disk changes, not even the log
hex-sync             # same as `hex-sync run`: sync once
```

A dry run prints one line per planned action, including claims it would restore and the
restored files' own plans, and appends `[failed: reason]` or `[skipped]` to lines that aren't
plans.

Every action is appended to the log as one tab-separated line: timestamp, action, path
(relative to the Outbox; to the Archive for `stale-temp`), target (relative to the Archive, or
the Outbox for `restore-claim`; `-` if none), outcome. A tab or newline in a file name is
written as is and breaks that line's format. Each line is also echoed to stdout; a closed
stdout is ignored. If a log line can't be written, the line goes to stderr, the pass stops,
and nothing more is moved.

Exit codes:

- `0`: done;
- `1`: some files failed, or a line could not be written (the log; on a dry run, stdout);
- `2`: nothing done (config error, the log's folder can't be created, the log or the lock file
  can't be opened or locked, the log lies inside a root or is a symlink, or a root check
  failed);
- `3`: nothing done because another run is in progress (see below).

### One run at a time

A run takes an exclusive `flock` on `<log>.lock` (for `sync.log`, `sync.log.lock`) right after
the root checks, which only read, and before it writes anything, the log included; it holds the
lock for the whole pass. If another run holds it, the run touches nothing, logs nothing, prints
`hex-sync: another run is in progress (lock <path>)` to stderr and exits `3`. The lock is
released when the process exits, however it exits, so a lock file left behind is harmless and
never needs deleting. A run that aborts takes no lock (it may not create the log's folder) and
only appends its abort line. A dry run takes no lock and doesn't create the lock file; run
during a live run, it may show that run's claims as `restore-claim` plans.

### Scheduling (macOS)

```sh
hex-sync install     # run every interval_secs as the launchd agent ai.stibbons.hex-sync
hex-sync uninstall   # unload the agent and remove its plist
```

`install [--config <path>] [--launch-agents-dir <dir>]` loads the config (failing on an invalid
one, or on a log that is a symlink or lies inside an existing Outbox or Archive; a missing root
is fine, it may be an unmounted drive), then writes `<dir>/ai.stibbons.hex-sync.plist`
(default dir `~/Library/LaunchAgents`, created if missing; the plist's mode is at most `0644`:
the umask can only narrow it, so it is never world-writable, which launchd rejects). The agent
runs `<this binary> run --config <absolute config path>` every `interval_secs`, the first time
one interval after loading. Its stdout goes to `/dev/null` (it only echoes the log); its
stderr, where config errors, aborts and refused runs show up, goes to
`~/Library/Logs/hex-sync.stderr.log`. That folder always exists, so launchd never creates a
folder on the agent's behalf (in the log's folder it could recreate a missing root before
hex-sync's checks run, or fail every start on an unmounted volume). Install then reloads the
agent (`launchctl bootout`, then `bootstrap gui/<uid>`). The plist holds `interval_secs`, the
config's path and the binary's resolved path: reinstall after changing `interval_secs` or
moving the config or the binary; other config edits apply on the next run.

`uninstall [--launch-agents-dir <dir>]` unloads the agent and removes the plist; either being
gone already is fine. Both commands say what they did and exit `0`, or `1` with the failing
step (a failed `launchctl` call is named with its stderr). A failed `bootstrap` leaves the
plist in place but no agent loaded, even one that was loaded before: fix the cause and rerun
`hex-sync install`.

Reinstalling or uninstalling while a scheduled pass runs stops it with SIGTERM (`bootout`
waits for it to exit). That is crash-safe: the next run restores the claims it left. A
half-written `.hex-sync-<n>.tmp` stays in the Archive and is logged as `stale-temp`.

Status: `launchctl print gui/$(id -u)/ai.stibbons.hex-sync` (run interval, runs, last exit
code). `HEX_SYNC_LAUNCHCTL` overrides the `launchctl` program (default `/bin/launchctl`); the
tests point it at a fake.

## Limits

- These paths are covered by code review only; triggering them through the CLI would need a
  fault hook:
  - a failed verification of an Archive copy;
  - a source changing between copy and removal;
  - races on the exclusive rename and on create-new temp files.

## Development

```sh
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
```

Tests run the built binary against temporary folders (`tests/cli.rs`).
