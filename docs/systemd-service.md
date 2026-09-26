# Running as a systemd service

The one-line installer (see the main README) sets up a hardened systemd
unit automatically, at `/etc/systemd/system/clawd-monitor-agent.service`.
To run the agent as a service manually, for example outside the
installer's supported Debian/Ubuntu target, create a unit file along
these lines:

```ini
[Unit]
Description=clawd-monitor agent
After=network.target

[Service]
User=clawd-agent
Group=clawd-agent
Environment=HOME=/var/lib/clawd-agent
ExecStart=/usr/bin/clawd-monitor-agent --config /etc/clawd-monitor-agent/config.json
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

The unit runs as an unprivileged system user, like the installer's unit.
Create it first if it does not exist (the installer uses the same command),
and optionally add it to the `docker` group so the docker collector can
run `docker ps`:

```bash
useradd --system --home-dir /var/lib/clawd-agent --create-home --shell /usr/sbin/nologin clawd-agent
usermod -aG docker clawd-agent   # optional, only if the host has a docker group
```

Membership in the `docker` group is root-equivalent; skip it (or run with
`--no-docker`) if you do not need container data.

The home directory must be writable: the agent caches its id in
`~/.clawd-agent-id`. With this unit, `~` is `/var/lib/clawd-agent`: sessions
are read from the service user's `$HOME/.openclaw`, so set `clawd_dir` (and
make the OpenClaw data readable) if your workspace lives elsewhere.

Use `command -v clawd-monitor-agent` to find the actual binary path for
`ExecStart` on your system. Create the config file with the same shape
the installer writes (see [CLI reference](cli-reference.md#config-file))
and keep it readable only by root and the service user, for example
`chmod 0640` and `chown root:clawd-agent /etc/clawd-monitor-agent/config.json`
(the installer does the same for its service user; use the group of
whichever user you set in `User=`).

The agent reads its token only from `--token` or the `--config` file; it
does not read any environment variable, so an `EnvironmentFile=` cannot
supply the token unless you reference it as `--token ${VAR}` in
`ExecStart`, and systemd expands `${VAR}` into the process argv before
exec, so the token would still end up visible in the process list. Use
the config file instead: it keeps the token out of `systemctl status`
and `ps`. Passing `--token` directly on the command line, by contrast,
is visible in `ps` output and in the process command line that
`systemctl status` shows.

Then enable and start it:

```bash
systemctl daemon-reload
systemctl enable --now clawd-monitor-agent
```
