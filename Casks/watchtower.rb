# Homebrew cask for WatchTower.
#
# Until this lands in a tap, install with the repo URL:
#   brew install --cask sinhaankur/tap/watchtower
# (after `brew tap sinhaankur/tap`), or point brew straight at this file.
#
# The version + sha256 values are bumped automatically by the release workflow
# (.github/workflows/release.yml) when a new vX.Y.Z is published, so the cask
# always tracks the latest DMG. `:no_check` on sha is NOT used — we pin the
# real checksum per arch for integrity.
cask "watchtower" do
  version "2.1.0"

  on_arm do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/sinhaankur/WatchTower/releases/download/v#{version}/WatchTower-#{version}-mac-arm64.dmg",
        verified: "github.com/sinhaankur/WatchTower/"
  end
  on_intel do
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    url "https://github.com/sinhaankur/WatchTower/releases/download/v#{version}/WatchTower-#{version}-mac-x64.dmg",
        verified: "github.com/sinhaankur/WatchTower/"
  end

  name "WatchTower"
  desc "Self-hosting that fixes itself — deploy from GitHub to a computer you own"
  homepage "https://sinhaankur.github.io/WatchTower/"

  # Require macOS 12+ (Monterey), matching the desktop app's deployment target.
  depends_on macos: ">= :monterey"

  app "WatchTower.app"

  # Clean up the per-user data + config the app writes, on `brew uninstall --zap`.
  zap trash: [
    "~/Library/Application Support/watchtower-desktop",
    "~/Library/Caches/watchtower-desktop",
    "~/Library/Preferences/com.sinhaankur.watchtower.plist",
    "~/Library/Logs/watchtower-desktop",
  ]
end
