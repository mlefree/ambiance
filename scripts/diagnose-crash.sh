#!/bin/bash

# Diagnose SIGSEGV crash by isolating native modules
# This script tests different module combinations to identify the culprit

echo "================================"
echo "Ambiance Crash Diagnosis Tool"
echo "================================"
echo ""

# Create backup of package.json
cp package.json package.json.backup

# Function to restore package.json
restore_package() {
    mv package.json.backup package.json
}

trap restore_package EXIT

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Log file
LOG_FILE=".logs/diagnosis-$(date +%Y%m%d-%H%M%S).log"
mkdir -p .logs

echo "Diagnosis log: $LOG_FILE"
echo ""

# Function to test with specific modules disabled
test_without_module() {
    local module=$1
    echo ""
    echo "================================"
    echo "Testing WITHOUT $module"
    echo "================================"

    # Temporarily remove the module
    npm uninstall "$module" --no-save

    # Rebuild
    echo "Building..."
    npm run build > /dev/null 2>&1

    if [ $? -ne 0 ]; then
        echo -e "${RED}Build failed without $module${NC}"
        npm install "$module" --no-save
        return 1
    fi

    # Test run with timeout
    echo "Running test (will timeout after 10 seconds)..."
    timeout 10s npm run start > /dev/null 2>&1
    EXIT_CODE=$?

    # Reinstall the module
    npm install "$module" --no-save > /dev/null 2>&1

    if [ $EXIT_CODE -eq 124 ]; then
        echo -e "${GREEN}✓ SUCCESS: App ran without crashing (timeout = good)${NC}"
        echo "SUSPECT MODULE: $module" >> "$LOG_FILE"
        return 0
    elif [ $EXIT_CODE -eq 139 ] || [ $EXIT_CODE -eq 134 ]; then
        echo -e "${RED}✗ CRASH: SIGSEGV still occurs without $module (exit $EXIT_CODE)${NC}"
        return 1
    else
        echo -e "${YELLOW}? UNCLEAR: Exit code $EXIT_CODE${NC}"
        return 2
    fi
}

# Native modules that could cause SIGSEGV
NATIVE_MODULES=(
    "acoustid"
    "essentia.js"
    "music-metadata"
    "node-id3"
    "@tensorflow/tfjs"
)

echo "Testing native modules that might cause SIGSEGV..."
echo "This will take several minutes..."
echo ""

SUSPECTS=()

for module in "${NATIVE_MODULES[@]}"; do
    test_without_module "$module"
    RESULT=$?

    if [ $RESULT -eq 0 ]; then
        SUSPECTS+=("$module")
    fi

    # Small delay between tests
    sleep 2
done

echo ""
echo "================================"
echo "Diagnosis Complete"
echo "================================"

if [ ${#SUSPECTS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Suspected modules causing SIGSEGV:${NC}"
    for suspect in "${SUSPECTS[@]}"; do
        echo -e "  ${RED}- $suspect${NC}"
    done
    echo ""
    echo "Recommendation: Try updating or removing these modules"
    echo "Check full log: $LOG_FILE"
else
    echo "No specific module identified as the cause."
    echo "The crash might be due to:"
    echo "  1. Module interaction (combination of modules)"
    echo "  2. Electron version compatibility"
    echo "  3. Node.js native addons rebuild needed"
    echo "  4. System-level issue (corrupted cache, etc.)"
    echo ""
    echo "Try:"
    echo "  npm run bp:_clean"
    echo "  npm rebuild"
    echo "  rm -rf ~/.electron"
fi

echo ""
echo "Full diagnosis saved to: $LOG_FILE"
