"""
Scheduling functionality for WatchTower
"""

import logging
import signal
import sys
from typing import Callable, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger


class Scheduler:
    """Manages scheduled tasks for WatchTower"""
    
    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize scheduler
        
        Args:
            logger: Logger instance
        """
        self.logger = logger or logging.getLogger("watchtower.scheduler")
        self.scheduler = BackgroundScheduler()
        self.running = False
        
        # Setup signal handlers for graceful shutdown
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        self.logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.stop()
        sys.exit(0)
    
    def add_job(self, func: Callable, interval_seconds: int, job_id: str = "update_check"):
        """
        Add a job to the scheduler
        
        Args:
            func: Function to execute
            interval_seconds: Interval in seconds
            job_id: Unique job identifier
        """
        trigger = IntervalTrigger(seconds=interval_seconds)
        self.scheduler.add_job(
            func,
            trigger=trigger,
            id=job_id,
            replace_existing=True,
            max_instances=1
        )
        self.logger.info(f"Scheduled job '{job_id}' to run every {interval_seconds} seconds")
    
    def start(self):
        """Start the scheduler"""
        if not self.running:
            self.scheduler.start()
            self.running = True
            self.logger.info("Scheduler started")
    
    def stop(self):
        """Stop the scheduler"""
        if self.running:
            self.scheduler.shutdown(wait=True)
            self.running = False
            self.logger.info("Scheduler stopped")
    
    def is_running(self) -> bool:
        """Check if scheduler is running"""
        return self.running
    
    def run_forever(self):
        """Run the scheduler indefinitely"""
        self.start()
        try:
            # Keep the main thread alive
            import time
            while self.running:
                time.sleep(1)
        except (KeyboardInterrupt, SystemExit):
            self.logger.info("Shutting down...")
            self.stop()
