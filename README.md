# WatchTower - Podman Container Management Service

WatchTower is an automated container management service for Podman that monitors your running containers and automatically updates them when new images are available. It's designed to keep your containerized applications up-to-date with minimal manual intervention.

## Features

- **Automatic Container Updates**: Monitors running Podman containers and automatically updates them when new images are available
- **Smart Scheduling**: Configurable update intervals with cron-like scheduling
- **Container Filtering**: Include or exclude specific containers from monitoring using wildcard patterns
- **Configuration Preservation**: Maintains container configurations, volumes, and environment variables during updates
- **Health Monitoring**: Verifies container health after updates
- **Graceful Updates**: Stops old containers gracefully before starting new ones
- **Image Cleanup**: Optional automatic cleanup of old images after successful updates
- **Dry-Run Mode**: Monitor-only mode to check for updates without applying them
- **Comprehensive Logging**: Detailed logging with rotation support
- **CLI Interface**: Command-line tools for manual operations and status checks
- **Systemd Integration**: Run as a system service with automatic startup
- **Cross-Platform Ready**: Designed with future Windows and macOS support in mind

## Requirements

- **Operating System**: Ubuntu/Linux (primary), designed for future Windows/macOS support
- **Python**: 3.8 or higher
- **Podman**: 3.0 or higher
- **Permissions**: Root or appropriate Podman socket access

## Installation

### Ubuntu/Linux Installation

1. **Install Podman** (if not already installed):
```bash
sudo apt update
sudo apt install podman
```

2. **Clone the repository**:
```bash
git clone https://github.com/sinhaankur/WatchTower.git
cd WatchTower
```

3. **Install WatchTower**:
```bash
# Install dependencies
pip3 install -r requirements.txt

# Install WatchTower
sudo python3 setup.py install
```

4. **Create configuration directory**:
```bash
sudo mkdir -p /etc/watchtower
sudo mkdir -p /var/log/watchtower
```

5. **Copy and configure**:
```bash
sudo cp config/watchtower.yml /etc/watchtower/
sudo nano /etc/watchtower/watchtower.yml  # Edit configuration
```

6. **Set up systemd service**:
```bash
sudo cp systemd/watchtower.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable watchtower
sudo systemctl start watchtower
```

### Manual Installation (Development)

For development or testing without system-wide installation:

```bash
# Install dependencies
pip3 install -r requirements.txt

# Run directly from source
python3 -m watchtower --help
```

## Configuration

WatchTower uses a YAML configuration file. The default locations searched are:
1. `/etc/watchtower/watchtower.yml`
2. `/opt/watchtower/config/watchtower.yml`
3. `./config/watchtower.yml`
4. `./watchtower.yml`

### Configuration Example

```yaml
watchtower:
  # Check interval in seconds (300 = 5 minutes)
  interval: 300
  
  # Remove old images after successful update
  cleanup: true
  
  # Monitor only mode - check for updates but don't apply them
  monitor_only: false

containers:
  # Include specific containers (empty means all)
  include: []
    # - "my-app"
    # - "web-*"  # Wildcard patterns supported
  
  # Exclude specific containers
  exclude:
    - "database-*"
    - "postgres"

notifications:
  enabled: true
  type: "log"  # log, email, webhook

logging:
  level: "INFO"  # DEBUG, INFO, WARNING, ERROR, CRITICAL
  file: "/var/log/watchtower/watchtower.log"
  max_size: "10MB"
  backup_count: 5
```

### Configuration Options

#### Watchtower Section
- `interval`: Update check interval in seconds (default: 300)
- `cleanup`: Remove old images after update (default: true)
- `monitor_only`: Dry-run mode, only check for updates (default: false)

#### Containers Section
- `include`: List of container names to monitor (empty = all containers)
- `exclude`: List of container names to exclude from monitoring
- Both support wildcard patterns using `*`

#### Notifications Section
- `enabled`: Enable notifications (default: true)
- `type`: Notification type - `log`, `email`, or `webhook`

#### Logging Section
- `level`: Log level - `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`
- `file`: Path to log file
- `max_size`: Maximum log file size before rotation (e.g., "10MB")
- `backup_count`: Number of backup log files to keep

## Usage

### CLI Commands

WatchTower provides several command-line commands:

#### Start Service
Start the WatchTower service (runs continuously):
```bash
watchtower start
```

Or with custom config:
```bash
watchtower -c /path/to/config.yml start
```

#### Check Status
View current status and monitored containers:
```bash
watchtower status
```

#### Immediate Update
Trigger an immediate update check:
```bash
watchtower update-now
```

#### List Containers
List all containers being monitored:
```bash
watchtower list-containers
```

#### Validate Configuration
Check if your configuration file is valid:
```bash
watchtower validate-config
```

### Running as a Service

#### Start/Stop Service
```bash
sudo systemctl start watchtower
sudo systemctl stop watchtower
sudo systemctl restart watchtower
```

#### Check Service Status
```bash
sudo systemctl status watchtower
```

#### View Logs
```bash
# Systemd logs
sudo journalctl -u watchtower -f

# Application logs
sudo tail -f /var/log/watchtower/watchtower.log
```

#### Enable Auto-Start
```bash
sudo systemctl enable watchtower
```

## How It Works

### Container Update Flow

1. **Discovery**: WatchTower scans all running Podman containers
2. **Filtering**: Applies include/exclude rules from configuration
3. **Update Check**: For each container, checks if a newer image exists in the registry
4. **Image Pull**: If an update is available, pulls the new image
5. **Graceful Stop**: Stops the old container with a timeout
6. **Container Recreation**: Creates a new container with the same configuration:
   - Same name
   - Same environment variables
   - Same port mappings
   - Same volume mounts
   - Same restart policy
   - Same labels
7. **Health Verification**: Verifies the new container is running
8. **Cleanup**: Optionally removes old, unused images
9. **Notification**: Logs the update result

### Container Configuration Preservation

WatchTower preserves the following during updates:
- Container name
- Environment variables
- Port bindings
- Volume mounts
- Restart policies
- Labels
- Command arguments

## Examples

### Monitor All Containers
```yaml
containers:
  include: []
  exclude: []
```

### Monitor Specific Containers
```yaml
containers:
  include:
    - "nginx"
    - "redis"
    - "app-*"
  exclude: []
```

### Exclude Databases
```yaml
containers:
  include: []
  exclude:
    - "postgres"
    - "mysql"
    - "mongodb"
    - "database-*"
```

### Dry-Run Mode
```yaml
watchtower:
  monitor_only: true
```

### Frequent Checks (Every Minute)
```yaml
watchtower:
  interval: 60
```

## Troubleshooting

### WatchTower Won't Start

1. Check if Podman is installed:
```bash
podman --version
```

2. Verify configuration:
```bash
watchtower validate-config
```

3. Check permissions:
```bash
# WatchTower needs access to Podman socket
ls -la /run/podman/podman.sock
```

### Containers Not Being Updated

1. Check if containers are being monitored:
```bash
watchtower list-containers
```

2. Review include/exclude rules in configuration

3. Check logs for errors:
```bash
sudo tail -f /var/log/watchtower/watchtower.log
```

### Permission Denied Errors

WatchTower typically needs to run as root or a user with Podman socket access:

```bash
# Run as root
sudo watchtower start

# Or configure rootless Podman (advanced)
```

### No Updates Detected

1. Manually check for image updates:
```bash
podman pull <image-name>
```

2. Verify the image tag in your container (avoid `latest` ambiguity)

3. Check if registry is accessible

## Security Considerations

- **Minimal Permissions**: Run with the minimum required permissions
- **Configuration Validation**: All configuration inputs are validated
- **No Hardcoded Credentials**: No credentials stored in code
- **Secure Updates**: Uses Podman's built-in security features
- **Graceful Handling**: Errors don't expose sensitive information

## Development

### Project Structure
```
watchtower/
├── watchtower/
│   ├── __init__.py
│   ├── __main__.py         # Module entry point
│   ├── main.py             # Main entry point
│   ├── cli.py              # CLI interface
│   ├── config.py           # Configuration parser
│   ├── logger.py           # Logging setup
│   ├── podman_manager.py   # Podman operations
│   ├── updater.py          # Update logic
│   └── scheduler.py        # Scheduling
├── config/
│   └── watchtower.yml      # Example config
├── systemd/
│   └── watchtower.service  # Systemd service
├── tests/
│   └── test_*.py           # Unit tests
├── README.md
├── LICENSE
├── requirements.txt
└── setup.py
```

### Running Tests

```bash
# Install test dependencies
pip3 install pytest pytest-cov

# Run tests
pytest tests/

# Run with coverage
pytest --cov=watchtower tests/
```

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure tests pass
6. Submit a pull request

## Future Roadmap

- [ ] Windows support with Docker Desktop
- [ ] macOS support
- [ ] Docker runtime support (in addition to Podman)
- [ ] Email notification support
- [ ] Webhook notification support
- [ ] Web UI for monitoring and configuration
- [ ] Container rollback capability
- [ ] Update scheduling with cron expressions
- [ ] Slack/Discord integration
- [ ] Metrics and monitoring integration (Prometheus)
- [ ] Multi-host support

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For issues, questions, or contributions, please visit:
- GitHub Issues: https://github.com/sinhaankur/WatchTower/issues
- Documentation: https://github.com/sinhaankur/WatchTower

## Acknowledgments

- Inspired by the Docker Watchtower project
- Built for the Podman container runtime
- Thanks to all contributors

---

**Note**: This is a container management tool that performs automatic updates. Always test in a non-production environment first and ensure you have proper backups before deploying to production systems.
