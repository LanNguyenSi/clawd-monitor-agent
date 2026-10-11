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
EnvironmentFile=-/etc/clawd-monitor-agent/openclaw.env
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
`~/.clawd-agent-id`. With this unit, `~` is `/var/lib/clawd-agent`. Memory
files are read from `clawd_dir` (default `~/.openclaw/workspace`), so if
your workspace lives elsewhere, set `clawd_dir` in the config file and make
that directory readable by the service user. Sessions and cron jobs do not
use `clawd_dir`: give the agent a Gateway token (see [OpenClaw data
sources](cli-reference.md#openclaw-data-sources)). The legacy JSONL
fallback reads only the service user's own `~/.openclaw`.

Use `command -v clawd-monitor-agent` to find the actual binary path for
`ExecStart` on your system. Create the config file with the same shape
the installer writes (see [CLI reference](cli-reference.md#config-file))
and keep it readable only by root and the service user, for example
`chmod 0640` and `chown root:clawd-agent /etc/clawd-monitor-agent/config.json`
(the installer does the same for its service user; use the group of
whichever user you set in `User=`).

The agent reads its dashboard token only from `--token` or the `--config`
file, never from the environment, so an `EnvironmentFile=` cannot supply
it unless you reference it as `--token ${VAR}` in
`ExecStart`, and systemd expands `${VAR}` into the process argv before
exec, so the token would still end up visible in the process list. Use
the config file instead: it keeps the token out of `systemctl status`
and `ps`. Passing `--token` directly on the command line, by contrast,
is visible in `ps` output and in the process command line that
`systemctl status` shows.

The OpenClaw Gateway token is different. The agent reads
`OPENCLAW_GATEWAY_TOKEN` from its environment and does not forward it to
the dashboard, so an `EnvironmentFile=` (mode 0600) is the recommended way
to set it, as in the unit above; see [OpenClaw data
sources](cli-reference.md#openclaw-data-sources).

Then enable and start it:

```bash
systemctl daemon-reload
systemctl enable --now clawd-monitor-agent
```

## Adjusting the installer's unit

The installer writes `/etc/systemd/system/clawd-monitor-agent.service` and
`/etc/clawd-monitor-agent/config.json` from scratch on every run, so edits
to either file are lost when you re-run it. Its unit runs the agent as
`clawd-agent` with `HOME=/var/lib/clawd-agent`, `ProtectSystem=strict`,
`ProtectHome=true` and `ReadWritePaths=/var/lib/clawd-agent`, and the
installer has no flag for the workspace path. To change the unit in a way
that survives re-runs, use a drop-in, which the installer does not touch:

```bash
systemctl edit clawd-monitor-agent
```

In the drop-in:

- **Gateway token.** Add `EnvironmentFile=` pointing at a file (mode 0600)
  that sets `OPENCLAW_GATEWAY_TOKEN=...`. The token then stays on the host;
  a token passed with the installer's `--gateway-token` goes into the
  config file and is forwarded to the dashboard.
- **Workspace path.** Clear `ExecStart` with an empty `ExecStart=` line,
  then repeat the installed `ExecStart=` line (see `systemctl cat
  clawd-monitor-agent`) with `--clawd-dir <path>` appended. The flag
  overrides the config file. The path must be readable by `clawd-agent`;
  a path under `/home` or `/root` also needs `ProtectHome=read-only` in the
  same drop-in.

For example:

```ini
[Service]
EnvironmentFile=/etc/clawd-monitor-agent/openclaw.env
ExecStart=
ExecStart=/usr/bin/clawd-monitor-agent --config /etc/clawd-monitor-agent/config.json --clawd-dir /srv/openclaw/workspace
```

Then restart the service with `systemctl restart clawd-monitor-agent`.
