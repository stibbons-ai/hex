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
interval_secs = 900                          # optional, default 900, > 0 (used by the scheduler)
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
written as is and breaks that line's format. Each
line is also echoed to stdout; a closed stdout is ignored. If a log line can't be written, the
line goes to stderr, the pass stops, and nothing more is moved.

Exit codes:

- `0`: done;
- `1`: some files failed, or a line could not be written (the log; on a dry run, stdout);
- `2`: nothing done (config error, the log can't be opened, lies inside a root or is a symlink,
  or a root check failed).

## Limits

- Concurrent runs aren't locked against each other. A second run restores the first run's
  claims, so the first run then fails on those files; nothing is lost.
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
