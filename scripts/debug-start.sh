#!/bin/bash

# Debug script for tracking SIGSEGV crashes in Electron/Node.js
# Usage: ./scripts/debug-start.sh

echo "================================"
echo "Ambiance Debug Start Script"
echo "================================"
echo ""

# Set debug environment variables
export DEBUG=*
export NODE_ENV=development
export ELECTRON_ENABLE_LOGGING=1
export ELECTRON_LOG_FILE=./electron-debug.log

# Clean up previous logs
rm -f ./electron-debug.log
rm -f ./crash.log
rm -f ./segfault.log

# Create log directory
mkdir -p .logs

# Log file paths
MAIN_LOG=".logs/debug-$(date +%Y%m%d-%H%M%S).log"
CRASH_LOG=".logs/crash-$(date +%Y%m%d-%H%M%S).log"

echo "Log files:"
echo "  Main log: $MAIN_LOG"
echo "  Crash log: $CRASH_LOG"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "================================"
    echo "Debug session ended"
    echo "================================"

    if [ -f "$CRASH_LOG" ] && [ -s "$CRASH_LOG" ]; then
        echo "CRASH DETECTED! Check $CRASH_LOG"
        tail -50 "$CRASH_LOG"
    fi
}

trap cleanup EXIT

# Start with detailed logging
echo "Starting Electron with debug logging..."
echo "Press Ctrl+C to stop"
echo ""

# Run with ulimit to catch segfaults and enable core dumps
ulimit -c unlimited

# Option 1: Run with Node.js debugging (uncomment to use)
# npm run build && node --inspect=9229 --trace-warnings node_modules/.bin/electron . 2>&1 | tee "$MAIN_LOG"

# Option 2: Run with LLDB debugger (uncomment to use on macOS)
# npm run build && lldb -- node_modules/.bin/electron . 2>&1 | tee "$MAIN_LOG"

# Option 3: Standard run with extensive logging (default)
npm run build 2>&1 | tee "$MAIN_LOG"

if [ $? -eq 0 ]; then
    echo "Build successful, starting Electron..."

    # Catch segfaults and crashes
    (npm run start 2>&1 || echo "EXIT CODE: $?") | tee -a "$MAIN_LOG"
    EXIT_CODE=${PIPESTATUS[0]}

    if [ $EXIT_CODE -ne 0 ]; then
        echo "CRASH DETECTED! Exit code: $EXIT_CODE" | tee "$CRASH_LOG"
        echo "Last 100 lines of log:" | tee -a "$CRASH_LOG"
        tail -100 "$MAIN_LOG" | tee -a "$CRASH_LOG"
    fi
else
    echo "Build failed! Check $MAIN_LOG"
fi
