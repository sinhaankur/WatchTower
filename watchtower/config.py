"""
Configuration management for WatchTower
"""

import os
import yaml
from pathlib import Path
from typing import Dict, List, Any, Optional


class Config:
    """Configuration parser and validator for WatchTower"""
    
    DEFAULT_CONFIG_PATHS = [
        "/etc/watchtower/watchtower.yml",
        "/opt/watchtower/config/watchtower.yml",
        "./config/watchtower.yml",
        "watchtower.yml"
    ]
    
    DEFAULT_CONFIG = {
        "watchtower": {
            "interval": 300,
            "cleanup": True,
            "monitor_only": False,
        },
        "containers": {
            "include": [],
            "exclude": [],
        },
        "notifications": {
            "enabled": True,
            "type": "log",
        },
        "logging": {
            "level": "INFO",
            "file": "/var/log/watchtower/watchtower.log",
            "max_size": "10MB",
            "backup_count": 5,
        }
    }
    
    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize configuration
        
        Args:
            config_path: Path to configuration file. If None, searches default paths.
        """
        self.config_path = config_path
        self.config = self._load_config()
        self._validate_config()
    
    def _find_config_file(self) -> Optional[str]:
        """Find configuration file in default paths"""
        if self.config_path and os.path.exists(self.config_path):
            return self.config_path
        
        for path in self.DEFAULT_CONFIG_PATHS:
            if os.path.exists(path):
                return path
        
        return None
    
    def _load_config(self) -> Dict[str, Any]:
        """Load configuration from file or use defaults"""
        config_file = self._find_config_file()
        
        if config_file:
            try:
                with open(config_file, 'r') as f:
                    user_config = yaml.safe_load(f)
                    # Merge with defaults
                    config = self._deep_merge(self.DEFAULT_CONFIG.copy(), user_config or {})
                    return config
            except Exception as e:
                print(f"Warning: Error loading config file {config_file}: {e}")
                print("Using default configuration")
        
        return self.DEFAULT_CONFIG.copy()
    
    def _deep_merge(self, base: Dict, override: Dict) -> Dict:
        """Deep merge two dictionaries"""
        result = base.copy()
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value
        return result
    
    def _validate_config(self):
        """Validate configuration values"""
        # Validate interval
        interval = self.config.get("watchtower", {}).get("interval", 300)
        if not isinstance(interval, int) or interval < 1:
            raise ValueError("watchtower.interval must be a positive integer")
        
        # Validate log level
        valid_levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        log_level = self.config.get("logging", {}).get("level", "INFO")
        if log_level not in valid_levels:
            raise ValueError(f"logging.level must be one of {valid_levels}")
        
        # Validate notification type
        valid_types = ["log", "email", "webhook"]
        notif_type = self.config.get("notifications", {}).get("type", "log")
        if notif_type not in valid_types:
            raise ValueError(f"notifications.type must be one of {valid_types}")
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get configuration value by dot-notation key"""
        keys = key.split(".")
        value = self.config
        for k in keys:
            if isinstance(value, dict):
                value = value.get(k, default)
            else:
                return default
        return value
    
    def get_watchtower_config(self) -> Dict[str, Any]:
        """Get watchtower section of config"""
        return self.config.get("watchtower", {})
    
    def get_containers_config(self) -> Dict[str, List[str]]:
        """Get containers section of config"""
        return self.config.get("containers", {})
    
    def get_notifications_config(self) -> Dict[str, Any]:
        """Get notifications section of config"""
        return self.config.get("notifications", {})
    
    def get_logging_config(self) -> Dict[str, Any]:
        """Get logging section of config"""
        return self.config.get("logging", {})
    
    def should_monitor_container(self, container_name: str) -> bool:
        """
        Check if a container should be monitored based on include/exclude rules
        
        Args:
            container_name: Name of the container
            
        Returns:
            True if container should be monitored, False otherwise
        """
        containers_config = self.get_containers_config()
        include_list = containers_config.get("include", [])
        exclude_list = containers_config.get("exclude", [])
        
        # If include list is specified, container must be in it
        if include_list:
            # Check exact match and wildcard patterns
            for pattern in include_list:
                if self._matches_pattern(container_name, pattern):
                    break
            else:
                return False
        
        # Check if container is in exclude list
        for pattern in exclude_list:
            if self._matches_pattern(container_name, pattern):
                return False
        
        return True
    
    def _matches_pattern(self, name: str, pattern: str) -> bool:
        """Check if name matches pattern (supports * wildcard)"""
        if "*" not in pattern:
            return name == pattern
        
        # Simple wildcard matching
        import re
        regex_pattern = pattern.replace("*", ".*")
        return re.match(f"^{regex_pattern}$", name) is not None
