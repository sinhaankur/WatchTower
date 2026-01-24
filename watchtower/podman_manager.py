"""
Podman container management for WatchTower
"""

import json
import subprocess
import logging
from typing import List, Dict, Any, Optional, Tuple


class PodmanManager:
    """Manages Podman containers"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize Podman manager
        
        Args:
            logger: Logger instance
        """
        self.logger = logger or logging.getLogger("watchtower.podman")
    
    def check_podman_installed(self) -> bool:
        """Check if Podman is installed and accessible"""
        try:
            result = subprocess.run(
                ["podman", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                self.logger.info(f"Podman found: {result.stdout.strip()}")
                return True
            return False
        except (subprocess.TimeoutExpired, FileNotFoundError):
            self.logger.error("Podman not found or not accessible")
            return False
    
    def list_running_containers(self) -> List[Dict[str, Any]]:
        """
        List all running containers
        
        Returns:
            List of container information dictionaries
        """
        try:
            result = subprocess.run(
                ["podman", "ps", "--format", "json"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                containers = json.loads(result.stdout)
                self.logger.debug(f"Found {len(containers)} running containers")
                return containers
            else:
                self.logger.error(f"Failed to list containers: {result.stderr}")
                return []
        except Exception as e:
            self.logger.error(f"Error listing containers: {e}")
            return []
    
    def get_container_info(self, container_id: str) -> Optional[Dict[str, Any]]:
        """
        Get detailed information about a container
        
        Args:
            container_id: Container ID or name
            
        Returns:
            Container information dictionary or None
        """
        try:
            result = subprocess.run(
                ["podman", "inspect", container_id],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                info = json.loads(result.stdout)
                return info[0] if info else None
            else:
                self.logger.error(f"Failed to inspect container {container_id}: {result.stderr}")
                return None
        except Exception as e:
            self.logger.error(f"Error inspecting container {container_id}: {e}")
            return None
    
    def get_image_digest(self, image_name: str) -> Optional[str]:
        """
        Get the digest of a local image
        
        Args:
            image_name: Image name
            
        Returns:
            Image digest or None
        """
        try:
            result = subprocess.run(
                ["podman", "inspect", "--format", "{{.Digest}}", image_name],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                digest = result.stdout.strip()
                return digest if digest and digest != "<no value>" else None
            return None
        except Exception as e:
            self.logger.error(f"Error getting image digest for {image_name}: {e}")
            return None
    
    def check_for_updates(self, image_name: str) -> Tuple[bool, Optional[str]]:
        """
        Check if an update is available for an image
        
        Args:
            image_name: Image name to check
            
        Returns:
            Tuple of (update_available, new_digest)
        """
        try:
            # Get current local image digest
            local_digest = self.get_image_digest(image_name)
            
            # Pull the latest image metadata (without downloading the full image)
            result = subprocess.run(
                ["podman", "pull", "--quiet", image_name],
                capture_output=True,
                text=True,
                timeout=120
            )
            
            if result.returncode != 0:
                self.logger.warning(f"Failed to check updates for {image_name}: {result.stderr}")
                return False, None
            
            # Get the new digest
            new_digest = self.get_image_digest(image_name)
            
            # Compare digests
            if local_digest and new_digest and local_digest != new_digest:
                self.logger.info(f"Update available for {image_name}")
                return True, new_digest
            
            return False, new_digest
        except Exception as e:
            self.logger.error(f"Error checking for updates for {image_name}: {e}")
            return False, None
    
    def pull_image(self, image_name: str) -> bool:
        """
        Pull an image from registry
        
        Args:
            image_name: Image name to pull
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.logger.info(f"Pulling image {image_name}")
            result = subprocess.run(
                ["podman", "pull", image_name],
                capture_output=True,
                text=True,
                timeout=600
            )
            
            if result.returncode == 0:
                self.logger.info(f"Successfully pulled {image_name}")
                return True
            else:
                self.logger.error(f"Failed to pull {image_name}: {result.stderr}")
                return False
        except Exception as e:
            self.logger.error(f"Error pulling image {image_name}: {e}")
            return False
    
    def stop_container(self, container_id: str, timeout: int = 10) -> bool:
        """
        Stop a container gracefully
        
        Args:
            container_id: Container ID or name
            timeout: Timeout in seconds before forcing stop
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.logger.info(f"Stopping container {container_id}")
            result = subprocess.run(
                ["podman", "stop", "-t", str(timeout), container_id],
                capture_output=True,
                text=True,
                timeout=timeout + 30
            )
            
            if result.returncode == 0:
                self.logger.info(f"Successfully stopped {container_id}")
                return True
            else:
                self.logger.error(f"Failed to stop {container_id}: {result.stderr}")
                return False
        except Exception as e:
            self.logger.error(f"Error stopping container {container_id}: {e}")
            return False
    
    def remove_container(self, container_id: str, force: bool = False) -> bool:
        """
        Remove a container
        
        Args:
            container_id: Container ID or name
            force: Force removal
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.logger.info(f"Removing container {container_id}")
            cmd = ["podman", "rm"]
            if force:
                cmd.append("-f")
            cmd.append(container_id)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                self.logger.info(f"Successfully removed {container_id}")
                return True
            else:
                self.logger.error(f"Failed to remove {container_id}: {result.stderr}")
                return False
        except Exception as e:
            self.logger.error(f"Error removing container {container_id}: {e}")
            return False
    
    def start_container(self, container_config: Dict[str, Any]) -> Optional[str]:
        """
        Start a new container with the given configuration
        
        Args:
            container_config: Container configuration from inspect
            
        Returns:
            New container ID or None
        """
        try:
            # Extract configuration
            config = container_config.get("Config", {})
            host_config = container_config.get("HostConfig", {})
            
            image = config.get("Image", "")
            name = container_config.get("Name", "").lstrip("/")
            
            # Build run command
            cmd = ["podman", "run", "-d"]
            
            # Add name
            if name:
                cmd.extend(["--name", name])
            
            # Add environment variables
            env = config.get("Env", [])
            for env_var in env:
                cmd.extend(["-e", env_var])
            
            # Add port bindings
            port_bindings = host_config.get("PortBindings", {})
            for container_port, host_bindings in port_bindings.items():
                if host_bindings:
                    for binding in host_bindings:
                        host_port = binding.get("HostPort", "")
                        if host_port:
                            cmd.extend(["-p", f"{host_port}:{container_port}"])
            
            # Add volume mounts
            binds = host_config.get("Binds", [])
            for bind in binds:
                cmd.extend(["-v", bind])
            
            # Add restart policy
            restart_policy = host_config.get("RestartPolicy", {})
            restart_name = restart_policy.get("Name", "")
            if restart_name:
                cmd.extend(["--restart", restart_name])
            
            # Add labels
            labels = config.get("Labels", {})
            for key, value in labels.items():
                cmd.extend(["--label", f"{key}={value}"])
            
            # Add image
            cmd.append(image)
            
            # Add command
            container_cmd = config.get("Cmd", [])
            if container_cmd:
                cmd.extend(container_cmd)
            
            self.logger.info(f"Starting new container: {' '.join(cmd)}")
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode == 0:
                new_container_id = result.stdout.strip()
                self.logger.info(f"Successfully started new container {new_container_id}")
                return new_container_id
            else:
                self.logger.error(f"Failed to start container: {result.stderr}")
                return None
        except Exception as e:
            self.logger.error(f"Error starting container: {e}")
            return None
    
    def check_container_health(self, container_id: str) -> bool:
        """
        Check if a container is running and healthy
        
        Args:
            container_id: Container ID or name
            
        Returns:
            True if healthy, False otherwise
        """
        try:
            result = subprocess.run(
                ["podman", "inspect", "--format", "{{.State.Status}}", container_id],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                status = result.stdout.strip()
                return status == "running"
            return False
        except Exception as e:
            self.logger.error(f"Error checking container health {container_id}: {e}")
            return False
    
    def remove_old_images(self, keep_tags: Optional[List[str]] = None) -> bool:
        """
        Remove dangling/unused images
        
        Args:
            keep_tags: List of image tags to keep
            
        Returns:
            True if successful, False otherwise
        """
        try:
            self.logger.info("Cleaning up old images")
            result = subprocess.run(
                ["podman", "image", "prune", "-f"],
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode == 0:
                self.logger.info("Successfully cleaned up old images")
                return True
            else:
                self.logger.warning(f"Image cleanup had issues: {result.stderr}")
                return False
        except Exception as e:
            self.logger.error(f"Error cleaning up images: {e}")
            return False
