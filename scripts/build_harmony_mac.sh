#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
destination=${1:-"$root/MacHost/.build/SideScreen Harmony.app"}
if [[ "$destination" != /* ]]; then destination="$PWD/$destination"; fi
if [[ -e "$destination" ]]; then
    printf 'Output already exists: %s\n' "$destination" >&2
    exit 1
fi

cd "$root/MacHost"
swift_options=()
macos_sdk=$(/usr/bin/xcrun --sdk macosx --show-sdk-path)
clt_sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
# The macOS 27 command-line SDK requires a SwiftUI macro shipped with Xcode.
if [[ "$macos_sdk" == /Library/Developer/CommandLineTools/SDKs/* && -d "$clt_sdk" ]]; then
    swift_options=(--sdk "$clt_sdk" --build-system native)
fi
swift build ${swift_options[@]+"${swift_options[@]}"} -c debug
bin=$(swift build ${swift_options[@]+"${swift_options[@]}"} -c debug --show-bin-path)

contents="$destination/Contents"
mkdir -p "$contents/MacOS" "$contents/Frameworks" "$contents/Resources"
cp "$bin/SideScreen" "$contents/MacOS/SideScreen"
ditto "$bin/Sparkle.framework" "$contents/Frameworks/Sparkle.framework"

version=$(tr -d '[:space:]' < "$root/VERSION")
cat > "$contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>CFBundleName</key><string>SideScreen Harmony</string>
    <key>CFBundleDisplayName</key><string>SideScreen Harmony</string>
    <key>CFBundleIdentifier</key><string>com.sidescreen.harmony</string>
    <key>CFBundleExecutable</key><string>SideScreen</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSScreenCaptureUsageDescription</key><string>SideScreen captures its virtual display to show it on the tablet over USB.</string>
    <key>NSLocalNetworkUsageDescription</key><string>SideScreen uses the local network when wireless mode is selected.</string>
    <key>NSBonjourServices</key><array><string>_sidescreen._tcp</string></array>
</dict></plist>
EOF

"$root/scripts/sign_app.sh" "$destination" -
printf '%s\n' "$destination"
