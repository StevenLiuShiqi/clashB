#!/bin/bash

echo "=== clashB Cleanup Tool ==="
echo "This script will remove all clashB related files and services."
read -p "Are you sure you want to continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

# Stop and unload services
echo "Stopping services..."
sudo launchctl unload /Library/LaunchDaemons/party.mihomo.helper.plist 2>/dev/null || true

# Remove files
echo "Removing files..."
sudo rm -f /Library/LaunchDaemons/party.mihomo.helper.plist
sudo rm -f /Library/PrivilegedHelperTools/party.mihomo.helper
sudo rm -rf "/Applications/clashB.app"
sudo rm -rf "/Applications/Clash\\ Party.app"
sudo rm -rf ~/Library/Application\ Support/clashb
sudo rm -rf ~/Library/Caches/clashb
sudo rm -f ~/Library/Preferences/com.multica.clashb.helper.plist
sudo rm -f ~/Library/Preferences/com.multica.clashb.plist

echo "Cleanup complete. Please restart your computer to complete the process."
