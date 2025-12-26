# Ambiance Testing Summary

## Overview

This document explains the different testing modes for Ambiance and when to use each one.

## Why Mood Information Wasn't Working

You were expecting mood information from `SPECS.mock-user.md`, but it wasn't working because:

1. **Essentia.js requires a renderer process** - Mood analysis runs in the browser context via Web Worker
2. **mock-user mode has no GUI** - No renderer process = no mood analyzer
3. **Fallback is used** - All files get `A#55555` instead of real mood codes
4. **Solution** - Use the GUI test mode for actual mood analysis

## Testing Modes

### 1. mock-all Mode (SPECS.mock-all.md)

**Script:** `scripts/test-mock-all.cjs`

- ✅ **Use case:** Quick smoke test, validate file discovery
- ❌ **No API calls** - No AcoustID metadata lookup
- ❌ **No file modifications** - Read-only
- ❌ **No mood analysis** - No GUI
- ⏱️ **Runtime:** 5 seconds
- 📊 **Results:** Basic file counting only

```bash
node scripts/test-mock-all.cjs
```

### 2. mock-api Mode (SPECS.mock-api.md)

**Script:** `scripts/test-mock-api.cjs`

- ✅ **Use case:** Test file processing without external API calls
- ✅ **File modifications allowed** - Renames files based on ID3 tags
- ❌ **No API calls** - No AcoustID metadata lookup
- ❌ **No mood analysis** - No GUI (uses fallback `A#55555`)
- ⏱️ **Runtime:** 30 seconds
- 📊 **Results:** Files organized using existing ID3 tags

```bash
node scripts/test-mock-api.cjs
```

### 3. mock-user Mode (SPECS.mock-user.md)

**Script:** `scripts/test-mock-user.cjs`

- ✅ **Use case:** Test full metadata processing with API (no mood analysis)
- ✅ **File modifications allowed** - Renames files
- ✅ **API calls allowed** - AcoustID at 1 call/minute
- ❌ **No mood analysis** - No GUI (uses fallback `A#55555`)
- ⏱️ **Runtime:** 30 seconds
- 📊 **Results:** Files organized with AcoustID metadata + fallback mood

```bash
node scripts/test-mock-user.cjs
```

**Limitation:** Cannot perform mood analysis without GUI. See test-all mode below.

### 4. test-all Mode

**Script:** `npm run start:clean`

- ✅ **Use case:** Full integration test with mood analysis
- ✅ **File modifications allowed** - Renames files
- ✅ **API calls allowed** - AcoustID at 1 call/minute
- ✅ **Mood analysis** - Full Essentia.js analysis via renderer
- ⏱️ **Runtime:** 60-90 seconds
- 📊 **Results:** Files organized with metadata + **real mood codes**
- ⚠️ **Requires:** Interactive desktop session (not SSH, not automated)

```bash
# Recommended: Use npm script from your Mac desktop Terminal
npm run start:clean
```

**Important:** This mode **crashes when run via SSH or Claude Code** due to Electron GUI requirements. Must be run from
an interactive Terminal session on your Mac.

## Comparison Table

| Feature                  | mock-all | mock-api | mock-user | test-all  |
|--------------------------|----------|----------|-----------|-----------|
| **API Calls (AcoustID)** | ❌        | ❌        | ✅ (1/min) | ✅ (1/min) |
| **File Modifications**   | ❌        | ✅        | ✅         | ✅         |
| **Mood Analysis**        | ❌        | ❌        | ❌         | ✅         |
| **GUI Required**         | ❌        | ❌        | ❌         | ✅         |
| **Can Run Automated**    | ✅        | ✅        | ✅         | ❌         |
| **Runtime**              | 5s       | 30s      | 30s       | 60-90s    |
| **Mood Code**            | N/A      | 55555    | 55555     | Real      |

## Key Files

```
ambiance/
├── scripts/
│   ├── test-mock-all.cjs      # Mode 1: Smoke test
│   ├── test-mock-api.cjs      # Mode 2: No API
│   ├── test-mock-user.cjs     # Mode 3: With API, no mood
├── SPECS.mock-all.md          # Documentation for mode 1
├── SPECS.mock-api.md          # Documentation for mode 2
├── SPECS.mock-user.md         # Documentation for mode 3
└── TESTING-SUMMARY.md         # This file
```

## Recommended Testing Workflow

### For Quick Validation

```bash
node scripts/test-mock-all.cjs   # 5 seconds, just check discovery works
```

### For Metadata Testing

```bash
node scripts/test-mock-user.cjs  # 30 seconds, test AcoustID + file organization
```

### For Full Mood Analysis Testing

```bash
# Open Terminal.app on your Mac desktop (not SSH)
cd /Users/lep/Workspace/mlefree/ambiance
npm run start:clean     # 90 seconds, includes mood analysis
```

## Understanding Mood Codes

Organized files follow this pattern:

```
Artist-Album-#Track-Title-A#<mood>-B#<bpm>.mp3
```

Example:

```
Bob Marley & The Wailers-Legend-#1-Easy Skanking-A#46628-B#120.mp3
                                                    ^^^^^    ^^^
                                                    mood     BPM
```

### Mood Code Format

- `A#55555` = Fallback (mood analyzer not available)
- `A#46628` = Real mood analysis from Essentia.js
- 5-7 digits representing mood characteristics

### Verifying Mood Analysis Worked

**Check for mood diversity:**

```bash
find mp3.gitignored -name "*-A#*-B#*.mp3" -exec basename {} \; | grep -o 'A#[0-9]*' | sort | uniq
```

**Expected (mood analysis working):**

```
A#46628
A#73421
A#52936
...
```

**Problem (mood analysis NOT working):**

```
A#55555
A#55555
A#55555
```

## Troubleshooting

### "All files have mood code 55555"

- Mood analyzer was not available (renderer process not running)
- Use `npm run start:clean` from interactive Terminal

### "Electron exited with signal SIGSEGV"

- Running Electron without proper display context
- Must run from interactive desktop session, not SSH/automated

### "No files organized"

- Check AcoustID rate limiting (1 call/minute)
- Runtime may have been too short
- Check for ID3 tags in original files

### "ambiance.json not created"

- App crashed before saving
- Check Electron process logs
- Verify `AMBIANCE_FOLDER` path is correct

## Next Steps

1. **For automated CI/CD:** Use `test-mock-user.cjs` (no mood, but reliable)
2. **For manual QA:** Use `npm run start:clean` (full features, requires desktop)
3. **For production mood analysis:** Consider running Essentia.js in main process instead of renderer
