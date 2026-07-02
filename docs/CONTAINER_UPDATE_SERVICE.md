# Container Update Service — Flow, Configuration, Troubleshooting

> Moved out of the repo README (2026-07-02) — reference docs for the
> `watchtower start` container auto-update daemon.

## How Container Update Flow Works

1. Discover running Podman containers
2. Apply include/exclude filters
3. Check for newer images
4. Pull updated image
5. Gracefully stop old container
6. Recreate with preserved config (env, ports, volumes, restart policy, labels, args)
7. Verify container health
8. Optionally clean old images
9. Emit logs/notifications

---

## Practical Configuration Examples

### Monitor all containers

```yaml
containers:
  include: []
  exclude: []
```

### Monitor specific containers

```yaml
containers:
  include:
    - "nginx"
    - "redis"
    - "app-*"
  exclude: []
```

### Exclude databases

```yaml
containers:
  include: []
  exclude:
    - "postgres"
    - "mysql"
    - "mongodb"
    - "database-*"
```

### Dry-run mode

```yaml
watchtower:
  monitor_only: true
```

### Frequent checks

```yaml
watchtower:
  interval: 60
```

---

## Troubleshooting

### WatchTower won’t start

```bash
podman --version
watchtower validate-config
ls -la /run/podman/podman.sock
```

### Containers not updating

```bash
watchtower list-containers
sudo tail -f /var/log/watchtower/watchtower.log
```

Also verify include/exclude rules and image/tag behavior.

### Permission denied

Run as root or configure appropriate Podman socket permissions.

### No updates detected

```bash
podman pull <image-name>
```

Confirm registry accessibility and image tag semantics.

---

