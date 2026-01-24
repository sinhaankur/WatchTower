from setuptools import setup, find_packages
from pathlib import Path

# Read README for long description
readme_file = Path(__file__).parent / "README.md"
long_description = ""
if readme_file.exists():
    long_description = readme_file.read_text(encoding="utf-8")

setup(
    name="watchtower-podman",
    version="1.0.0",
    author="WatchTower Contributors",
    author_email="",
    description="Podman Container Management Service for automatic updates",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/sinhaankur/WatchTower",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: System Administrators",
        "Topic :: System :: Systems Administration",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Operating System :: POSIX :: Linux",
    ],
    python_requires=">=3.8",
    install_requires=[
        "pyyaml>=6.0",
        "apscheduler>=3.10.0",
        "podman>=4.0.0",
        "requests>=2.28.0",
    ],
    entry_points={
        "console_scripts": [
            "watchtower=watchtower.cli:main",
        ],
    },
    include_package_data=True,
    package_data={
        "": ["*.yml", "*.yaml"],
    },
    data_files=[
        ("/etc/watchtower", ["config/watchtower.yml"]),
        ("/etc/systemd/system", ["systemd/watchtower.service"]),
    ],
)
