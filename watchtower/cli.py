"""
Command-line interface for WatchTower
"""

import argparse
import sys
import logging
from typing import Optional

from .config import Config
from .logger import get_logger
from .podman_manager import PodmanManager
from .updater import Updater
from .scheduler import Scheduler


class CLI:
    """Command-line interface for WatchTower"""
    
    def __init__(self):
        self.parser = self._create_parser()
        self.config: Optional[Config] = None
        self.logger: Optional[logging.Logger] = None
        self.podman: Optional[PodmanManager] = None
        self.updater: Optional[Updater] = None
    
    def _create_parser(self) -> argparse.ArgumentParser:
        """Create argument parser"""
        parser = argparse.ArgumentParser(
            prog="watchtower",
            description="WatchTower - Podman Container Management Service"
        )
        
        parser.add_argument(
            "-c", "--config",
            help="Path to configuration file",
            default=None
        )
        
        parser.add_argument(
            "-v", "--version",
            action="version",
            version="WatchTower 1.0.0"
        )
        
        subparsers = parser.add_subparsers(dest="command", help="Available commands")
        
        # Start command
        subparsers.add_parser("start", help="Start WatchTower service")
        
        # Stop command
        subparsers.add_parser("stop", help="Stop WatchTower service")
        
        # Status command
        subparsers.add_parser("status", help="Show WatchTower status")
        
        # Update now command
        subparsers.add_parser("update-now", help="Trigger immediate update check")
        
        # List containers command
        subparsers.add_parser("list-containers", help="List monitored containers")
        
        # Validate config command
        subparsers.add_parser("validate-config", help="Validate configuration file")
        
        return parser
    
    def _initialize(self, config_path: Optional[str] = None):
        """Initialize components"""
        try:
            # Load configuration
            self.config = Config(config_path)
            
            # Setup logging
            self.logger = get_logger(self.config.get_logging_config())
            
            # Initialize Podman manager
            self.podman = PodmanManager(self.logger)
            
            # Check if Podman is installed
            if not self.podman.check_podman_installed():
                self.logger.error("Podman is not installed or not accessible")
                sys.exit(1)
            
            # Initialize updater
            watchtower_config = self.config.get_watchtower_config()
            self.updater = Updater(self.podman, watchtower_config, self.logger)
            
        except Exception as e:
            print(f"Error initializing WatchTower: {e}")
            sys.exit(1)
    
    def cmd_start(self):
        """Start WatchTower service"""
        self.logger.info("Starting WatchTower service...")
        
        # Get configuration
        interval = self.config.get("watchtower.interval", 300)
        
        # Create update function
        def update_task():
            self.logger.info("Running scheduled update check...")
            
            # Filter function based on config
            def should_monitor(container):
                names = container.get("Names", [])
                if names:
                    return self.config.should_monitor_container(names[0])
                return True
            
            results = self.updater.update_all_containers(should_monitor)
            
            # Log results
            for container_name, success in results.items():
                if success:
                    self.logger.info(f"✓ {container_name}: Updated successfully")
                else:
                    self.logger.info(f"✗ {container_name}: No updates or update failed")
        
        # Run initial check
        self.logger.info("Running initial update check...")
        update_task()
        
        # Setup scheduler
        scheduler = Scheduler(self.logger)
        scheduler.add_job(update_task, interval)
        
        self.logger.info(f"WatchTower service started (checking every {interval} seconds)")
        
        # Run forever
        scheduler.run_forever()
    
    def cmd_stop(self):
        """Stop WatchTower service"""
        self.logger.info("Stopping WatchTower service...")
        # In a real implementation, this would signal the running service
        print("To stop the service, use: systemctl stop watchtower")
    
    def cmd_status(self):
        """Show WatchTower status"""
        self.logger.info("Checking WatchTower status...")
        
        # Check Podman
        if self.podman.check_podman_installed():
            print("✓ Podman is installed and accessible")
        else:
            print("✗ Podman is not accessible")
            return
        
        # List containers
        containers = self.podman.list_running_containers()
        print(f"\nRunning containers: {len(containers)}")
        
        # Show monitored containers
        monitored = [c for c in containers 
                    if self.config.should_monitor_container(c.get("Names", [""])[0])]
        print(f"Monitored containers: {len(monitored)}")
        
        if monitored:
            print("\nMonitored containers:")
            for container in monitored:
                name = container.get("Names", ["unknown"])[0]
                image = container.get("Image", "unknown")
                status = container.get("State", "unknown")
                print(f"  - {name} ({image}) [{status}]")
    
    def cmd_update_now(self):
        """Trigger immediate update check"""
        self.logger.info("Running immediate update check...")
        
        # Filter function based on config
        def should_monitor(container):
            names = container.get("Names", [])
            if names:
                return self.config.should_monitor_container(names[0])
            return True
        
        results = self.updater.update_all_containers(should_monitor)
        
        # Display results
        print("\nUpdate Results:")
        for container_name, success in results.items():
            status = "✓ Updated" if success else "✗ No updates or failed"
            print(f"  {container_name}: {status}")
        
        total = len(results)
        successful = sum(1 for v in results.values() if v)
        print(f"\nSummary: {successful}/{total} containers updated")
    
    def cmd_list_containers(self):
        """List monitored containers"""
        print("Monitored Containers:")
        print("-" * 80)
        
        containers = self.podman.list_running_containers()
        
        if not containers:
            print("No running containers found")
            return
        
        # Filter monitored containers
        monitored = []
        for container in containers:
            names = container.get("Names", [])
            if names and self.config.should_monitor_container(names[0]):
                monitored.append(container)
        
        if not monitored:
            print("No containers match monitoring criteria")
            return
        
        for container in monitored:
            container_id = container.get("Id", "")[:12]
            name = container.get("Names", ["unknown"])[0]
            image = container.get("Image", "unknown")
            status = container.get("State", "unknown")
            created = container.get("Created", "unknown")
            
            print(f"\nContainer: {name}")
            print(f"  ID: {container_id}")
            print(f"  Image: {image}")
            print(f"  Status: {status}")
            print(f"  Created: {created}")
    
    def cmd_validate_config(self):
        """Validate configuration file"""
        print("Validating configuration...")
        
        try:
            # Config is already loaded and validated in _initialize
            print("✓ Configuration is valid")
            
            # Show key settings
            print("\nConfiguration Summary:")
            print(f"  Interval: {self.config.get('watchtower.interval')} seconds")
            print(f"  Cleanup: {self.config.get('watchtower.cleanup')}")
            print(f"  Monitor Only: {self.config.get('watchtower.monitor_only')}")
            
            containers_config = self.config.get_containers_config()
            include_list = containers_config.get("include", [])
            exclude_list = containers_config.get("exclude", [])
            
            if include_list:
                print(f"  Include: {', '.join(include_list)}")
            else:
                print("  Include: All containers")
            
            if exclude_list:
                print(f"  Exclude: {', '.join(exclude_list)}")
            
            print(f"  Notifications: {self.config.get('notifications.type')}")
            print(f"  Log Level: {self.config.get('logging.level')}")
            print(f"  Log File: {self.config.get('logging.file')}")
            
        except Exception as e:
            print(f"✗ Configuration validation failed: {e}")
            sys.exit(1)
    
    def run(self, args=None):
        """Run CLI"""
        parsed_args = self.parser.parse_args(args)
        
        if not parsed_args.command:
            self.parser.print_help()
            sys.exit(0)
        
        # Initialize components
        self._initialize(parsed_args.config)
        
        # Execute command
        command_map = {
            "start": self.cmd_start,
            "stop": self.cmd_stop,
            "status": self.cmd_status,
            "update-now": self.cmd_update_now,
            "list-containers": self.cmd_list_containers,
            "validate-config": self.cmd_validate_config,
        }
        
        command_func = command_map.get(parsed_args.command)
        if command_func:
            command_func()
        else:
            self.parser.print_help()
            sys.exit(1)


def main():
    """Main entry point"""
    cli = CLI()
    cli.run()


if __name__ == "__main__":
    main()
