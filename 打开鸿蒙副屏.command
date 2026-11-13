#!/bin/bash
set -e
cd "$(dirname "$0")"
if [[ $# -eq 0 ]] && ! /usr/bin/pgrep -qx SideScreen; then
    /usr/bin/open -g -b com.sidescreen.app || true
fi
exec python3 HarmonyClient/bridge.py "$@"
