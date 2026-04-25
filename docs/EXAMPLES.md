# WatchTower Usage Examples

This document provides practical examples of using WatchTower in various scenarios.

## Basic Setup

### 1. Monitor All Containers

The simplest configuration - monitor and auto-update all running containers:

```yaml
# /etc/watchtower/watchtower.yml
watchtower:
  interval: 300  # Check every 5 minutes
  cleanup: true
  monitor_only: false

containers:
  include: []  # Empty = all containers
  exclude: []

logging:
  level: "INFO"
  file: "/var/log/watchtower/watchtower.log"
```

### 2. Monitor Specific Containers

Only monitor containers you explicitly list:

```yaml
watchtower:
  interval: 600  # Check every 10 minutes
  cleanup: true

containers:
  include:
    - "nginx"
    - "redis"
    - "web-app"
  exclude: []
```

### 3. Exclude Critical Services

Monitor all containers except critical ones:

```yaml
watchtower:
  interval: 300
  cleanup: true

containers:
  include: []  # All containers
  exclude:
    - "postgres"
    - "mysql"
    - "mongodb"
    - "database-*"  # Any container starting with "database-"
```

## Advanced Scenarios

### Development Environment

For development, use monitor-only mode to see what would be updated without actually updating:

```yaml
watchtower:
  interval: 60  # Check every minute
  cleanup: false
  monitor_only: true  # Dry-run mode

containers:
  include: []
  exclude: []

logging:
  level: "DEBUG"  # Verbose logging
  file: "/var/log/watchtower/watchtower.log"
```

Run manually to see updates:
```bash
watchtower update-now
```

### Production Environment

Conservative settings for production:

```yaml
watchtower:
  interval: 3600  # Check once per hour
  cleanup: true
  monitor_only: false

containers:
  include:
    - "web-frontend"
    - "api-server"
    - "cache-*"  # All cache containers
  exclude:
    - "database-*"  # Never auto-update databases
    - "postgres"
    - "mysql"

logging:
  level: "INFO"
  file: "/var/log/watchtower/watchtower.log"
  max_size: "50MB"
  backup_count: 10
```

### Pattern Matching Examples

```yaml
containers:
  include:
    - "web-*"      # Matches: web-frontend, web-backend, web-api
    - "app-*"      # Matches: app-server, app-worker, app-cache
    - "prod-*"     # Matches: prod-nginx, prod-redis
  exclude:
    - "*-test"     # Excludes: web-test, app-test
    - "staging-*"  # Excludes: staging-app, staging-db
```

## CLI Commands

### Check System Status

```bash
# View current status
watchtower status

# Output:
# ✓ Podman is installed and accessible
# Running containers: 5
# Monitored containers: 3
# 
# Monitored containers:
#   - nginx (nginx:latest) [running]
#   - redis (redis:alpine) [running]
#   - web-app (myapp:latest) [running]
```

### Manual Update Check

```bash
# Trigger immediate update check
watchtower update-now

# Output:
# Update Results:
#   nginx: ✓ Updated
#   redis: ✗ No updates or failed
#   web-app: ✓ Updated
# 
# Summary: 2/3 containers updated
```

### List Monitored Containers

```bash
# Show all containers being monitored
watchtower list-containers

# Output:
# Monitored Containers:
# --------------------------------------------------------------------------------
# 
# Container: nginx
#   ID: a1b2c3d4e5f6
#   Image: nginx:latest
#   Status: running
#   Created: 2026-01-20T10:30:00Z
# 
# Container: redis
#   ID: f6e5d4c3b2a1
#   Image: redis:alpine
#   Status: running
#   Created: 2026-01-21T14:15:30Z
```

### Validate Configuration

```bash
# Check if configuration is valid
watchtower validate-config

# Output:
# Validating configuration...
# ✓ Configuration is valid
# 
# Configuration Summary:
#   Interval: 300 seconds
#   Cleanup: True
#   Monitor Only: False
#   Include: All containers
#   Notifications: log
#   Log Level: INFO
```

### Using Custom Config File

```bash
# Use a different config file
watchtower -c /path/to/custom-config.yml status
watchtower --config /path/to/custom-config.yml update-now
```

## Systemd Service Management

### Start Service

```bash
# Start WatchTower service
sudo systemctl start watchtower

# Enable auto-start on boot
sudo systemctl enable watchtower

# Start and enable in one command
sudo systemctl enable --now watchtower
```

### Check Status

```bash
# Check service status
sudo systemctl status watchtower

# Output:
# ● watchtower.service - WatchTower - Podman Container Management Service
#    Loaded: loaded (/etc/systemd/system/watchtower.service; enabled)
#    Active: active (running) since Fri 2026-01-24 10:00:00 UTC; 2h ago
#    Main PID: 12345 (python3)
```

### View Logs

```bash
# View systemd logs (real-time)
sudo journalctl -u watchtower -f

# View last 50 lines
sudo journalctl -u watchtower -n 50

# View application logs
sudo tail -f /var/log/watchtower/watchtower.log
```

### Stop Service

```bash
# Stop service
sudo systemctl stop watchtower

# Disable auto-start
sudo systemctl disable watchtower
```

## Container Examples

### Running Test Containers

To test WatchTower, you can run some sample containers:

```bash
# Run nginx
podman run -d --name nginx -p 8080:80 nginx:latest

# Run redis
podman run -d --name redis -p 6379:6379 redis:alpine

# Run a test app
podman run -d --name test-app -e ENV=production nginx:alpine

# List running containers
podman ps
```

### Testing Updates

```bash
# 1. Configure WatchTower to monitor specific containers
cat > /tmp/test-config.yml << EOF
watchtower:
  interval: 60
  cleanup: true
  monitor_only: false

containers:
  include:
    - "nginx"
    - "redis"
  exclude: []
EOF

# 2. Run WatchTower with test config (will check every 60 seconds)
watchtower -c /tmp/test-config.yml start

# In another terminal, check status
watchtower -c /tmp/test-config.yml status
```

## Troubleshooting Examples

### Debug Mode

For troubleshooting, use debug logging:

```yaml
logging:
  level: "DEBUG"
  file: "/var/log/watchtower/debug.log"
```

Then check logs:
```bash
tail -f /var/log/watchtower/debug.log
```

### Dry Run Test

Test configuration without making changes:

```yaml
watchtower:
  monitor_only: true  # Enable dry-run mode
```

Run update check:
```bash
watchtower update-now
# This will only log what would be updated
```

### Permission Issues

If you get permission errors:

```bash
# Create log directory with correct permissions
sudo mkdir -p /var/log/watchtower
sudo chmod 755 /var/log/watchtower

# Run as root or user with Podman access
sudo watchtower status
```

## Integration Examples

### Cron Alternative

If you prefer cron over the service:

```bash
# Add to crontab (run every hour)
0 * * * * /usr/local/bin/watchtower update-now >> /var/log/watchtower/cron.log 2>&1
```

### Script Integration

Use WatchTower in your scripts:

```bash
#!/bin/bash
# Update script

echo "Checking for container updates..."
watchtower update-now

if [ $? -eq 0 ]; then
    echo "Update check completed successfully"
else
    echo "Update check failed"
    exit 1
fi
```

## Best Practices

1. **Start with Monitor-Only Mode**: Test configuration without actually updating
2. **Use Specific Include Lists**: Be explicit about what to update
3. **Exclude Databases**: Never auto-update database containers
4. **Regular Intervals**: Don't check too frequently (5-10 minutes minimum)
5. **Enable Cleanup**: Remove old images to save disk space
6. **Monitor Logs**: Regularly check logs for issues
7. **Test in Dev First**: Validate updates in development before production
8. **Backup Before Updates**: Always have backups of important data

## Security Considerations

```yaml
# Example secure configuration
watchtower:
  interval: 3600  # Check once per hour
  cleanup: true
  monitor_only: false

containers:
  # Only update approved containers
  include:
    - "app-frontend"
    - "app-backend"
  # Exclude everything else
  exclude:
    - "*"  # Explicit deny-all, then allow specific ones above
```

## Additional Resources

- Main README: [README.md](README.md)
- Contributing Guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Issue Tracker: https://github.com/sinhaankur/WatchTower/issues
