#!/bin/bash

echo "Starting Electron with debug logging..."
echo "This will run for 10 seconds to check for crashes"
echo ""

npm run start:debug > /dev/null 2>&1 &
ELECTRON_PID=$!

echo "Electron PID: $ELECTRON_PID"
echo "Waiting 10 seconds..."

sleep 10

if ps -p $ELECTRON_PID > /dev/null 2>&1; then
    echo "✓ SUCCESS: Still running after 10 seconds - no immediate crash!"
    kill $ELECTRON_PID 2>/dev/null
    killall Electron 2>/dev/null || true
    echo ""
    echo "Check logs for any warnings:"
    echo "  ls -lht .logs/"
    exit 0
else
    echo "✗ CRASH: Process terminated"
    echo ""
    echo "Checking logs..."
    LATEST_LOG=$(ls -t .logs/app-*.log 2>/dev/null | head -1)
    if [ -f "$LATEST_LOG" ]; then
        echo "Latest app log: $LATEST_LOG"
        echo "Last 30 lines:"
        tail -30 "$LATEST_LOG"
    fi
    exit 1
fi
