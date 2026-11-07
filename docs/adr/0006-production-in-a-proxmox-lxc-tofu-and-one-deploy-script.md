# Production runs in a Proxmox LXC, provisioned by OpenTofu and deployed by one script

hex's only production deployment is an unprivileged Debian 13 system container on Daniel's Proxmox in the LAN; `compose.yaml` and the container image stay the development and CI path. OpenTofu with the `bpg/proxmox` provider creates the container, its static IP and a separate mount point `/var/lib/hex` (LibSQL, DuckDB and the Outbox) that is protected from destroy and included in Proxmox backups, so replacing the container keeps the state. `bun run deploy` runs `tofu apply` and then, over SSH, installs pinned Bun 1.4.2 and the server bundle, cross-built on the Mac by `scripts/build-server.ts --os linux --cpu x64 --libc glibc`, into `/opt/hex/releases/<git-sha>`; it runs `smoke.js` there, switches the `current` symlink, restarts the systemd unit and waits for `healthcheck.js`, switching back to the previous release on failure (`--app-only` skips Tofu).

## Considered Options

- The existing image as a Proxmox OCI app container: a tech preview, and the distroless image has no shell or systemd to debug or supervise with.
- Docker inside the LXC: needs nesting, which Proxmox advises against.
- Ansible for the contents: a second toolchain, inventory and roles for one container running one service. Tofu `file`/`remote-exec` provisioners: run once at creation and drift afterwards.

## Consequences

- The bind stays as [ADR 0005](0005-container-binds-all-interfaces-publish-on-loopback.md) decided: the server listens on loopback inside the LXC, the LAN can't reach it until an authenticated LAN mode exists, and `/rpc` is reached through an SSH tunnel.
- Secrets never enter Tofu state: the deploy script renders `op://` references with `op inject` on the Mac and copies `/etc/hex/hex.env` (mode 0600, the unit's `EnvironmentFile`) and `/etc/hex/config.json` (`HEX_CONFIG`) into the LXC.
- Tofu state is a local, gitignored file encrypted with OpenTofu's state encryption, its key read from 1Password; node, storage, bridge, VMID, addresses and SSH public keys sit in a gitignored `terraform.tfvars` beside a committed example. Tofu authenticates with an API token of a dedicated Proxmox user.
- One instance only: a second hex anywhere else would poll the same mailbox again.
- The Outbox now lives on another machine than the Archive; [ADR 0007](0007-hex-sync-pulls-the-outbox-over-ssh.md) records how Documents reach the Mac.
