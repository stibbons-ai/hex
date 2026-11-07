# hex-sync pulls the server's Outbox over SSH before moving Documents to the Archive

Amends [ADR 0001](0001-sync-moves-documents-out-of-the-server.md). With the server in a Proxmox LXC ([ADR 0006](0006-production-in-a-proxmox-lxc-tofu-and-one-deploy-script.md)) and Proton Drive on the Mac, the server's Outbox is no longer a folder hex-sync can read locally. Each hex-sync run therefore first pulls from an optional `pull` source in its config (`hexsync@<lxc>:/var/lib/hex/outbox/`) with rsync over SSH into a local Outbox on the Mac, skipping `*.partial`, and removes a file on the server only once its local copy is flushed and byte-identical: the rule ADR 0001 applies towards the Archive, applied one hop earlier. The unchanged pass then moves the local Outbox into the Archive, under the same launchd schedule, lock and log.

## Considered Options

- An SMB share of the Outbox mounted on the Mac: needs Samba in the LXC, and hex-sync's no-replace renames and device/inode identity checks are unproven on an SMB mount.
- Proton Drive inside the LXC through rclone's `protondrive` backend: unofficial, and it would move hex-sync off the Mac.
- `rsync --remove-source-files`: deletes on the server before the local copy is flushed, and the options of macOS's bundled openrsync are not something to depend on.
- A separate launchd agent running rsync: a second schedule racing the first, and a second log to read when a Document goes missing.

## Consequences

- The LXC has a `hexsync` user without a shell whose key, held only on the Mac, is restricted by `rrsync` to `/var/lib/hex/outbox`; it is separate from the admin access the deploy uses.
- A Document passes through two Outboxes, the server's and the Mac's; it stays in neither once it reaches the Archive.
- Without `pull`, hex-sync behaves as before, against a local Outbox.
