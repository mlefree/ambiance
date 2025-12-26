#!/usr/bin/env node

/**
 * Test node-id3 on each MP3 file to find which one causes SIGSEGV
 */

const NodeID3 = require('node-id3');
const fs = require('fs');
const path = require('path');

const MP3_FOLDER = './mp3.gitignored.original';

// Find all MP3 files
function findMP3Files(dir) {
    const files = [];

    function walk(directory) {
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.name.toLowerCase().endsWith('.mp3')) {
                files.push(fullPath);
            }
        }
    }

    walk(dir);
    return files;
}

console.log('Finding MP3 files...');
const mp3Files = findMP3Files(MP3_FOLDER);
console.log(`Found ${mp3Files.length} MP3 files\n`);

console.log('Testing node-id3 read on each file...\n');

let successCount = 0;
let failCount = 0;

for (const file of mp3Files) {
    const basename = path.basename(file);
    process.stdout.write(`Testing ${basename.padEnd(50)} ... `);

    try {
        // This is where SIGSEGV likely happens
        const tags = NodeID3.read(file);
        console.log('✓ OK');
        successCount++;
    } catch (error) {
        console.log(`✗ CRASH/ERROR: ${error.message}`);
        failCount++;
        console.log(`  File: ${file}`);
        console.log(`  This file likely causes the SIGSEGV!`);
    }
}

console.log(`\n========================================`);
console.log(`Results: ${successCount} OK, ${failCount} failed`);

if (failCount === 0) {
    console.log('\n✓ All files tested successfully!');
    console.log('The crash might be happening during write operations or in a different module.');
} else {
    console.log('\n✗ Found problematic files!');
    console.log('These files likely cause the SIGSEGV during processing.');
}
