# Running as a systemd service

The one-line installer (see the main README) sets up a hardened systemd
unit automatically. To run the agent as a service manually, for example
outside the installer's supported Debian/Ubuntu target, create a unit file
along these lines:

```ini
[Unit]
Description=clawd-monitor agent
After=network.target

[Service]
ExecStart=/usr/bin/clawd-monitor-agent \
  --server https://your-clawd-monitor-domain \
  --token <agent-token> \
  --name "My OpenClaw Host" \
  --gateway http://localhost:18789
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
systemctl daemon-reload
systemctl enable --now clawd-monitor-agent
```

Store the token outside the unit file (an `EnvironmentFile=` or the
`--config` JSON file) if you want to avoid it appearing in `systemctl
status` output or the process list; the installer's own unit does this
for you.
