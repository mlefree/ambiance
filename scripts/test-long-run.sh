#!/bin/bash

echo "Starting long-running test (30 seconds)"
echo "This will process MP3 files and check for SIGSEGV"
echo ""

# Clean start
rm -rf mp3.gitignored
cp -rf mp3.gitignored.original mp3.gitignored

# Start with logging
npm run build > /dev/null 2>&1
echo "Build complete, starting Electron..."

ELECTRON_ENABLE_LOGGING=1 ./node_modules/.bin/electron . > .logs/long-test.log 2>&1 &
ELECTRON_PID=$!

echo "Electron PID: $ELECTRON_PID"
echo "Monitoring for 30 seconds..."
echo ""

for i in {1..30}; do
    if ! ps -p $ELECTRON_PID > /dev/null 2>&1; then
        echo ""
        echo "✗ CRASH DETECTED at ${i} seconds!"
        echo ""
        echo "=== Last 50 lines of log ==="
        tail -50 .logs/long-test.log
        echo ""
        echo "=== Latest app log ==="
        LATEST_APP_LOG=$(ls -t .logs/app-*.log 2>/dev/null | head -1)
        if [ -f "$LATEST_APP_LOG" ]; then
            tail -30 "$LATEST_APP_LOG"
        fi
        exit 1
    fi
    printf "."
    sleep 1
done

echo ""
echo ""
echo "✓ SUCCESS: Ran for 30 seconds without crashing!"

# Clean shutdown
kill $ELECTRON_PID 2>/dev/null
killall Electron 2>/dev/null || true

echo ""
echo "=== Processing log (last 30 lines) ==="
tail -30 .logs/long-test.log

exit 0
