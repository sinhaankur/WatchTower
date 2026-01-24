"""
Logging setup for WatchTower
"""

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional


class Logger:
    """Logging configuration and setup for WatchTower"""
    
    def __init__(self, config: dict):
        """
        Initialize logger
        
        Args:
            config: Logging configuration dictionary
        """
        self.config = config
        self.logger = None
    
    def setup(self) -> logging.Logger:
        """Setup and configure logger"""
        # Get configuration
        log_level = self.config.get("level", "INFO")
        log_file = self.config.get("file", "/var/log/watchtower/watchtower.log")
        max_size_str = self.config.get("max_size", "10MB")
        backup_count = self.config.get("backup_count", 5)
        
        # Parse max size
        max_size = self._parse_size(max_size_str)
        
        # Create logger
        logger = logging.getLogger("watchtower")
        logger.setLevel(getattr(logging, log_level))
        
        # Remove existing handlers
        logger.handlers.clear()
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(getattr(logging, log_level))
        console_format = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        console_handler.setFormatter(console_format)
        logger.addHandler(console_handler)
        
        # File handler with rotation
        try:
            # Create log directory if it doesn't exist
            log_dir = Path(log_file).parent
            log_dir.mkdir(parents=True, exist_ok=True)
            
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=max_size,
                backupCount=backup_count
            )
            file_handler.setLevel(getattr(logging, log_level))
            file_format = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(file_format)
            logger.addHandler(file_handler)
        except (PermissionError, OSError) as e:
            logger.warning(f"Could not create file handler for {log_file}: {e}")
            logger.warning("Logging to console only")
        
        self.logger = logger
        return logger
    
    def _parse_size(self, size_str: str) -> int:
        """
        Parse size string to bytes
        
        Args:
            size_str: Size string (e.g., "10MB", "1GB")
            
        Returns:
            Size in bytes
        """
        size_str = size_str.upper().strip()
        
        multipliers = {
            'B': 1,
            'KB': 1024,
            'MB': 1024 * 1024,
            'GB': 1024 * 1024 * 1024,
        }
        
        for suffix, multiplier in multipliers.items():
            if size_str.endswith(suffix):
                number_str = size_str[:-len(suffix)].strip()
                try:
                    return int(float(number_str) * multiplier)
                except ValueError:
                    pass
        
        # Default to 10MB if parsing fails
        return 10 * 1024 * 1024
    
    def get_logger(self) -> logging.Logger:
        """Get the configured logger instance"""
        if self.logger is None:
            return self.setup()
        return self.logger


def get_logger(config: Optional[dict] = None) -> logging.Logger:
    """
    Get or create logger instance
    
    Args:
        config: Optional logging configuration
        
    Returns:
        Configured logger instance
    """
    if config is None:
        config = {
            "level": "INFO",
            "file": "/var/log/watchtower/watchtower.log",
            "max_size": "10MB",
            "backup_count": 5,
        }
    
    logger_instance = Logger(config)
    return logger_instance.setup()
