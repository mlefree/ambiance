#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {execSync} = require('child_process');

const projectRoot = path.join(__dirname, '..');
const mp3Folder = path.join(projectRoot, 'mp3.gitignored');
const mp3Original = path.join(projectRoot, 'mp3.gitignored.original');
const ambianceJson = path.join(mp3Folder, 'ambiance.json');

console.log('[test-mock-user] Starting test setup...');

// Step 1: Remove mp3.gitignored if it exists
if (fs.existsSync(mp3Folder)) {
    console.log('[test-mock-user] Removing existing mp3.gitignored folder...');
    execSync(`rm -rf "${mp3Folder}"`, {stdio: 'inherit'});
}

// Step 2: Copy mp3.gitignored.original to mp3.gitignored
console.log('[test-mock-user] Copying mp3.gitignored.original to mp3.gitignored...');
execSync(`cp -r "${mp3Original}" "${mp3Folder}"`, {stdio: 'inherit'});

// Step 3: Build the app
console.log('[test-mock-user] Building the app...');
try {
    execSync('npm run build', {cwd: projectRoot, stdio: 'inherit'});
} catch (error) {
    console.error('[test-mock-user] Build failed!');
    process.exit(1);
}

// Step 4: Set environment to mock-user mode
process.env.MODE = 'mock-user';
process.env.AMBIANCE_FOLDER = mp3Folder;
console.log('[test-mock-user] Environment set: MODE=mock-user, AMBIANCE_FOLDER=' + mp3Folder);

// Step 5: Run the app in mock-user mode (non-interactive)
console.log('[test-mock-user] Running app in mock-user mode...');
console.log('[test-mock-user] Note: API calls allowed (1 call/minute rate limit)');
console.log('[test-mock-user] Note: File modifications allowed');
console.log('[test-mock-user] Press Ctrl+C to stop when ready or wait 30 seconds...');

// Run electron in background with timeout
const {spawn} = require('child_process');
const electron = spawn('npx', ['electron', '.'], {
    cwd: projectRoot,
    env: {
        ...process.env,
        MODE: 'mock-user',
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
    console.log('[test-mock-user] Stopping electron after 30 seconds...');
    electron.kill();

    // Wait a bit for cleanup
    setTimeout(() => {
        // Step 6: Verify ambiance.json was created
        console.log('\n[test-mock-user] Checking results...');
        if (fs.existsSync(ambianceJson)) {
            const data = JSON.parse(fs.readFileSync(ambianceJson, 'utf-8'));
            console.log('\n[test-mock-user] ✓ ambiance.json created successfully!');
            console.log('\nContents:');
            console.log(JSON.stringify(data, null, 2));

            console.log('\n[test-mock-user] Stats:');
            console.log(`  - tracks.length: ${data.tracks?.length || 0}`);
            console.log(`  - playlist.length: ${data.playlist?.length || 0}`);
            console.log(`  - toProcess.length: ${data.toProcess?.length || 0}`);

            // Check that Jamaluna file is NOT in toProcess (since it matches the pattern)
            const jamalunaFile =
                'Jamaluna/Peniche/Jamaluna-Peniche-#1-51 Fever-A#46628-B#120.mp3';
            const hasJamaluna = data.toProcess?.some((file) => file.includes(jamalunaFile));
            if (hasJamaluna) {
                console.log(
                    '\n[test-mock-user] ⚠ WARNING: Jamaluna file should NOT be in toProcess (it matches the pattern)'
                );
            } else {
                console.log('\n[test-mock-user] ✓ Jamaluna file correctly NOT in toProcess');
            }

            // Check if files were processed (should have been organized/renamed)
            console.log('\n[test-mock-user] Checking if files were organized...');
            const allFiles = [];
            const findFiles = (dir) => {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    if (fs.statSync(fullPath).isDirectory()) {
                        findFiles(fullPath);
                    } else if (item.endsWith('.mp3')) {
                        allFiles.push(fullPath);
                    }
                }
            };
            findFiles(mp3Folder);

            console.log(`[test-mock-user] Total MP3 files in folder: ${allFiles.length}`);
            const organizedFiles = allFiles.filter((f) => {
                const fileName = path.basename(f);
                return fileName.match(/-A#\d{5}-B#\d+\.mp3$/);
            });
            console.log(`[test-mock-user] Files with mood codes: ${organizedFiles.length}`);

            // Show some sample organized files
            if (organizedFiles.length > 0) {
                console.log('\n[test-mock-user] Sample organized files:');
                organizedFiles.slice(0, 5).forEach((f) => {
                    console.log(`  - ${path.relative(mp3Folder, f)}`);
                });
            }

            // Verify expectations
            const expectationsMet = {
                tracks: data.tracks?.length === 0,
                playlist:
                    data.playlist?.length > 0 && data.playlist?.length <= 20,
                toProcess:
                    data.toProcess?.length >= 0 && data.toProcess?.length <= 20,
            };

            if (expectationsMet.tracks && expectationsMet.playlist && expectationsMet.toProcess) {
                console.log('\n[test-mock-user] ✓ All expectations met!');
                console.log('  ✓ tracks.length = 0 (no files played)');
                console.log(`  ✓ playlist.length = ${data.playlist?.length} (organized files ready to play)`);
                console.log(`  ✓ toProcess.length = ${data.toProcess?.length} (files queued for processing, max 20)`);
            } else {
                console.log('\n[test-mock-user] ⚠ Some expectations not met:');
                if (!expectationsMet.tracks) {
                    console.log(`  - Expected tracks.length = 0, got ${data.tracks?.length}`);
                }
                if (!expectationsMet.playlist) {
                    console.log(
                        `  - Expected 0 < playlist.length <= 20, got ${data.playlist?.length}`
                    );
                }
                if (!expectationsMet.toProcess) {
                    console.log(`  - Expected toProcess.length <= 20, got ${data.toProcess?.length}`);
                }
            }
        } else {
            console.log('[test-mock-user] ✗ ambiance.json was NOT created!');
        }

        process.exit(0);
    }, 2000);
}, 30000);

// Handle manual Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[test-mock-user] Interrupted by user, stopping electron...');
    electron.kill();
    process.exit(0);
});
