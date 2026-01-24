"""
Container update logic for WatchTower
"""

import logging
import time
from typing import Dict, List, Any, Optional
from .podman_manager import PodmanManager


class Updater:
    """Handles container update logic"""
    
    def __init__(self, podman_manager: PodmanManager, config: Dict[str, Any], 
                 logger: Optional[logging.Logger] = None):
        """
        Initialize updater
        
        Args:
            podman_manager: PodmanManager instance
            config: Configuration dictionary
            logger: Logger instance
        """
        self.podman = podman_manager
        self.config = config
        self.logger = logger or logging.getLogger("watchtower.updater")
        self.monitor_only = config.get("monitor_only", False)
        self.cleanup = config.get("cleanup", True)
    
    def update_container(self, container: Dict[str, Any]) -> bool:
        """
        Update a single container
        
        Args:
            container: Container information dictionary
            
        Returns:
            True if update successful, False otherwise
        """
        try:
            container_id = container.get("Id", "")[:12]
            container_name = container.get("Names", ["unknown"])[0]
            image_name = container.get("Image", "")
            
            self.logger.info(f"Checking for updates: {container_name} ({container_id})")
            
            # Check for updates
            update_available, new_digest = self.podman.check_for_updates(image_name)
            
            if not update_available:
                self.logger.info(f"No updates available for {container_name}")
                return False
            
            self.logger.info(f"Update available for {container_name}")
            
            # If monitor only mode, just log and return
            if self.monitor_only:
                self.logger.info(f"Monitor-only mode: Would update {container_name}")
                return True
            
            # Get full container configuration
            container_info = self.podman.get_container_info(container_id)
            if not container_info:
                self.logger.error(f"Failed to get configuration for {container_name}")
                return False
            
            # Pull the new image
            if not self.podman.pull_image(image_name):
                self.logger.error(f"Failed to pull new image for {container_name}")
                return False
            
            # Stop the old container
            if not self.podman.stop_container(container_id):
                self.logger.error(f"Failed to stop {container_name}")
                return False
            
            # Remove the old container
            if not self.podman.remove_container(container_id):
                self.logger.error(f"Failed to remove old container {container_name}")
                return False
            
            # Start new container with same configuration
            new_container_id = self.podman.start_container(container_info)
            if not new_container_id:
                self.logger.error(f"Failed to start new container for {container_name}")
                return False
            
            # Wait a bit and check health
            time.sleep(5)
            if self.podman.check_container_health(new_container_id):
                self.logger.info(f"Successfully updated {container_name} to new container {new_container_id[:12]}")
                
                # Cleanup old images if enabled
                if self.cleanup:
                    self.podman.remove_old_images()
                
                return True
            else:
                self.logger.error(f"New container {new_container_id[:12]} is not healthy")
                return False
                
        except Exception as e:
            self.logger.error(f"Error updating container: {e}")
            return False
    
    def update_all_containers(self, container_filter_func=None) -> Dict[str, bool]:
        """
        Update all containers that match filter criteria
        
        Args:
            container_filter_func: Optional function to filter containers
            
        Returns:
            Dictionary mapping container names to update success status
        """
        results = {}
        
        # Get all running containers
        containers = self.podman.list_running_containers()
        
        if not containers:
            self.logger.info("No running containers found")
            return results
        
        # Filter containers
        if container_filter_func:
            containers = [c for c in containers if container_filter_func(c)]
        
        self.logger.info(f"Checking {len(containers)} containers for updates")
        
        # Update each container
        for container in containers:
            container_name = container.get("Names", ["unknown"])[0]
            try:
                success = self.update_container(container)
                results[container_name] = success
            except Exception as e:
                self.logger.error(f"Error processing {container_name}: {e}")
                results[container_name] = False
        
        # Summary
        successful = sum(1 for v in results.values() if v)
        self.logger.info(f"Update check complete: {successful}/{len(results)} containers updated")
        
        return results
    
    def check_single_container(self, container_name: str) -> Optional[bool]:
        """
        Check if a specific container needs updates
        
        Args:
            container_name: Name of container to check
            
        Returns:
            True if update available, False if not, None if container not found
        """
        containers = self.podman.list_running_containers()
        
        for container in containers:
            names = container.get("Names", [])
            if container_name in names:
                image_name = container.get("Image", "")
                update_available, _ = self.podman.check_for_updates(image_name)
                return update_available
        
        self.logger.warning(f"Container {container_name} not found")
        return None
