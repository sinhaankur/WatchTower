"""
Basic tests for WatchTower configuration
"""

import pytest
import tempfile
import os
from pathlib import Path
from watchtower.config import Config


def test_default_config():
    """Test default configuration loading"""
    config = Config()
    assert config.get("watchtower.interval") == 300
    assert config.get("watchtower.cleanup") == True
    assert config.get("logging.level") == "INFO"


def test_custom_config():
    """Test loading custom configuration"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False) as f:
        f.write("""
watchtower:
  interval: 600
  cleanup: false
  monitor_only: true
        """)
        config_path = f.name
    
    try:
        config = Config(config_path)
        assert config.get("watchtower.interval") == 600
        assert config.get("watchtower.cleanup") == False
        assert config.get("watchtower.monitor_only") == True
    finally:
        os.unlink(config_path)


def test_container_filtering():
    """Test container filtering logic"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False) as f:
        f.write("""
containers:
  include:
    - "web-*"
    - "app-server"
  exclude:
    - "database-*"
        """)
        config_path = f.name
    
    try:
        config = Config(config_path)
        
        # Should be monitored (matches include pattern)
        assert config.should_monitor_container("web-frontend") == True
        assert config.should_monitor_container("app-server") == True
        
        # Should not be monitored (matches exclude pattern)
        assert config.should_monitor_container("database-prod") == False
        
        # Should not be monitored (doesn't match include list)
        assert config.should_monitor_container("redis") == False
    finally:
        os.unlink(config_path)


def test_wildcard_matching():
    """Test wildcard pattern matching"""
    config = Config()
    
    # Test pattern matching
    assert config._matches_pattern("web-frontend", "web-*") == True
    assert config._matches_pattern("web-backend", "web-*") == True
    assert config._matches_pattern("api-server", "web-*") == False
    assert config._matches_pattern("exact-match", "exact-match") == True


def test_invalid_config_validation():
    """Test configuration validation"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False) as f:
        f.write("""
watchtower:
  interval: -1
        """)
        config_path = f.name
    
    try:
        with pytest.raises(ValueError):
            Config(config_path)
    finally:
        os.unlink(config_path)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
