#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

const projectRoot = path.join(__dirname, '..');
const mp3Folder = path.join(projectRoot, 'mp3.gitignored');
const mp3Original = path.join(projectRoot, 'mp3.gitignored.original');
const ambianceJson = path.join(mp3Folder, 'ambiance.json');

console.log('[test-mock-all] Starting test setup...');

// Step 1: Remove mp3.gitignored if it exists
if (fs.existsSync(mp3Folder)) {
    console.log('[test-mock-all] Removing existing mp3.gitignored folder...');
    execSync(`rm -rf "${mp3Folder}"`, {stdio: 'inherit'});
}

// Step 2: Copy mp3.gitignored.original to mp3.gitignored
console.log('[test-mock-all] Copying mp3.gitignored.original to mp3.gitignored...');
execSync(`cp -r "${mp3Original}" "${mp3Folder}"`, {stdio: 'inherit'});

// Step 3: Build the app
console.log('[test-mock-all] Building the app...');
try {
    execSync('npm run build', {cwd: projectRoot, stdio: 'inherit'});
} catch (error) {
    console.error('[test-mock-all] Build failed!');
    process.exit(1);
}

// Step 4: Set environment to mock-all mode
process.env.MODE = 'mock-all';
process.env.AMBIANCE_FOLDER = mp3Folder;
console.log('[test-mock-all] Environment set: MODE=mock-all, AMBIANCE_FOLDER=' + mp3Folder);

// Step 5: Run the app in mock-all mode (non-interactive)
console.log('[test-mock-all] Running app in mock-all mode...');
console.log('[test-mock-all] Note: The app will process files and create ambiance.json');
console.log('[test-mock-all] Press Ctrl+C to stop when ready or wait 30 seconds...');

// Run electron in background with timeout
const {spawn} = require('child_process');
const electron = spawn('npx', ['electron', '.'], {
    cwd: projectRoot,
    env: {
        ...process.env,
        MODE: 'mock-all',
        AMBIANCE_FOLDER: mp3Folder,
    },
});

let output = '';
electron.stdout.on('data', (data) => {
    output += data.toString();
    console.log(data.toString());
});

electron.stderr.on('data', (data) => {
    output += data.toString();
    console.error(data.toString());
});

// Wait 30 seconds for processing, then kill the electron app
setTimeout(() => {
    console.log('[test-mock-all] Stopping electron after 30 seconds...');
    electron.kill();

    // Wait a bit for cleanup
    setTimeout(() => {
        // Step 6: Verify ambiance.json was created
        console.log('\n[test-mock-all] Checking results...');
        if (fs.existsSync(ambianceJson)) {
            const data = JSON.parse(fs.readFileSync(ambianceJson, 'utf-8'));
            console.log('\n[test-mock-all] ✓ ambiance.json created successfully!');
            console.log('\nContents:');
            console.log(JSON.stringify(data, null, 2));

            console.log('\n[test-mock-all] Stats:');
            console.log(`  - tracks.length: ${data.tracks?.length || 0}`);
            console.log(`  - playlist.length: ${data.playlist?.length || 0}`);
            console.log(`  - toProcess.length: ${data.toProcess?.length || 0}`);

            // Check that Jamaluna file is NOT in toProcess (since it matches the pattern)
            const jamalunaFile =
                'Jamaluna/Peniche/Jamaluna-Peniche-#1-51 Fever-A#46628-B#120.mp3';
            const hasJamaluna = data.toProcess?.some((file) => file.includes(jamalunaFile));
            if (hasJamaluna) {
                console.log(
                    '\n[test-mock-all] ⚠ WARNING: Jamaluna file should NOT be in toProcess (it matches the pattern)'
                );
            } else {
                console.log('\n[test-mock-all] ✓ Jamaluna file correctly NOT in toProcess');
            }

            // Verify expectations
            if (
                data.tracks?.length === 0 &&
                data.playlist?.length > 0 &&
                data.playlist?.length <= 20 &&
                data.toProcess?.length > 0 &&
                data.toProcess?.length <= 20
            ) {
                console.log('\n[test-mock-all] ✓ All expectations met!');
            } else {
                console.log('\n[test-mock-all] ⚠ Some expectations not met:');
                if (data.tracks?.length !== 0) {
                    console.log(`  - Expected tracks.length = 0, got ${data.tracks?.length}`);
                }
                if (data.playlist?.length === 0 || data.playlist?.length > 20) {
                    console.log(
                        `  - Expected 0 < playlist.length <= 20, got ${data.playlist?.length}`
                    );
                }
                if (data.toProcess?.length === 0 || data.toProcess?.length > 20) {
                    console.log(
                        `  - Expected 0 < toProcess.length <= 20, got ${data.toProcess?.length}`
                    );
                }
            }
        } else {
            console.log('[test-mock-all] ✗ ambiance.json was NOT created!');
        }

        process.exit(0);
    }, 2000);
}, 30000);

// Handle manual Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[test-mock-all] Interrupted by user, stopping electron...');
    electron.kill();
    process.exit(0);
});
