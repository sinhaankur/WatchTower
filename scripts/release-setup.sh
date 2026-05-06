#!/bin/bash
# WatchTower Release & Setup Script
# This script helps you create tags and set up your repository for distribution

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  WatchTower Release & Setup Tool       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check if we're in the right directory
if [ ! -f "$PROJECT_ROOT/watchtower/__init__.py" ]; then
    echo -e "${RED}Error: Not in WatchTower root directory${NC}"
    echo "Please run this script from the WatchTower repository root"
    exit 1
fi

# Function to get current version
get_version() {
    grep "__version__" "$PROJECT_ROOT/watchtower/__init__.py" | grep -oP '"\K[^"]*'
}

# Function to show current version
show_version() {
    local version=$(get_version)
    echo -e "${GREEN}Current version: ${YELLOW}$version${NC}"
}

# Function to create and push tag
create_tag() {
    local version=$1
    local tag="v$version"
    
    echo ""
    echo -e "${BLUE}Creating tag: ${YELLOW}$tag${NC}"
    
    if git rev-parse "$tag" >/dev/null 2>&1; then
        echo -e "${RED}Error: Tag $tag already exists${NC}"
        return 1
    fi
    
    echo -e "${YELLOW}Checking git status...${NC}"
    if [ -n "$(git status --porcelain)" ]; then
        echo -e "${RED}Error: Uncommitted changes exist${NC}"
        echo "Please commit all changes before creating a tag"
        git status --short
        return 1
    fi
    
    echo -e "${YELLOW}Creating annotated tag...${NC}"
    local message="Release WatchTower $version"
    git tag -a "$tag" -m "$message"
    
    echo -e "${YELLOW}Pushing tag to GitHub...${NC}"
    git push origin "$tag"
    
    echo -e "${GREEN}✓ Tag created and pushed: $tag${NC}"
    echo -e "${GREEN}GitHub Actions will automatically build and publish to:${NC}"
    echo -e "  • GitHub Releases"
    echo -e "  • GitHub Container Registry (ghcr.io)"
    echo -e "  • PyPI (watchtower-podman)"
    echo ""
    echo -e "${BLUE}Monitor the release:${NC}"
    echo -e "  https://github.com/Node2-io/WatchTowerOps/actions"
    echo -e "  https://github.com/Node2-io/WatchTowerOps/releases"
}

# Function to show branch protection setup
show_branch_protection() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Branch Protection Setup (GitHub)      ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}To protect the main branch, visit:${NC}"
    echo ""
    echo "  https://github.com/Node2-io/WatchTowerOps/settings/branches"
    echo ""
    echo -e "${YELLOW}Or follow these steps:${NC}"
    echo "  1. Go to Settings → Branches"
    echo "  2. Click 'Add rule'"
    echo "  3. Branch name pattern: ${GREEN}main${NC}"
    echo "  4. Check these boxes:"
    echo "     ✓ Require a pull request before merging"
    echo "     ✓ Require approvals (1–2)"
    echo "     ✓ Require status checks to pass"
    echo "     ✓ Require branches to be up to date"
    echo "     ✓ Include administrators"
    echo "     ✓ Dismiss stale reviews"
    echo "  5. Uncheck:"
    echo "     ☐ Allow force pushes"
    echo "     ☐ Allow deletions"
    echo "  6. Click 'Create'"
    echo ""
    echo -e "${GREEN}For detailed instructions, see:${NC}"
    echo "  BRANCH_PROTECTION.md"
    echo ""
}

# Function to show release workflow
show_release_workflow() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Release Workflow                      ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}When you push a tag (v1.2.3):${NC}"
    echo ""
    echo -e "${GREEN}GitHub Actions automatically:${NC}"
    echo "  1. Validates version matches watchtower/__init__.py"
    echo "  2. Builds Docker image: ghcr.io/sinhaankur/watchtower:v1.2.3"
    echo "  3. Tags as: ghcr.io/sinhaankur/watchtower:latest"
    echo "  4. Publishes Python package to PyPI"
    echo "  5. Creates GitHub Release"
    echo ""
    echo -e "${YELLOW}Users can then download via:${NC}"
    echo ""
    echo "  Docker:   docker pull ghcr.io/sinhaankur/watchtower:v1.2.3"
    echo "  PyPI:     pip install watchtower-podman==1.2.3"
    echo "  GitHub:   https://github.com/Node2-io/WatchTowerOps/releases"
    echo ""
}

# Function to show documentation links
show_documentation() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Documentation & Resources            ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Key Documents:${NC}"
    echo "  • ${GREEN}RELEASE.md${NC} — Release management guide"
    echo "  • ${GREEN}BRANCH_PROTECTION.md${NC} — Branch protection setup"
    echo "  • ${GREEN}docs/VERCEL_ALTERNATIVE.md${NC} — Why WatchTower replaces Vercel"
    echo "  • ${GREEN}README.md${NC} — Main project documentation"
    echo ""
    echo -e "${YELLOW}External Links:${NC}"
    echo "  • Releases: https://github.com/Node2-io/WatchTowerOps/releases"
    echo "  • Container Registry: https://github.com/Node2-io/WatchTowerOps/pkgs/container/watchtower"
    echo "  • PyPI: https://pypi.org/project/watchtower-podman/"
    echo "  • Actions: https://github.com/Node2-io/WatchTowerOps/actions"
    echo ""
}

# Main menu
show_menu() {
    echo ""
    echo -e "${YELLOW}What would you like to do?${NC}"
    echo ""
    echo "  1) Create and push a release tag"
    echo "  2) Show branch protection setup instructions"
    echo "  3) Show release workflow information"
    echo "  4) Show documentation links"
    echo "  5) Show current version"
    echo "  6) Exit"
    echo ""
}

# Main loop
while true; do
    show_menu
    read -p "Choose an option (1-6): " choice
    
    case $choice in
        1)
            show_version
            read -p "Enter version to release (or press Enter to skip): " version
            if [ -n "$version" ]; then
                create_tag "$version"
            fi
            ;;
        2)
            show_branch_protection
            ;;
        3)
            show_release_workflow
            ;;
        4)
            show_documentation
            ;;
        5)
            show_version
            ;;
        6)
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid choice. Please try again.${NC}"
            ;;
    esac
done
