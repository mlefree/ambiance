#!/usr/bin/env node

/**
 * Test script to verify native modules can load without crashing
 * Run: node scripts/test-native-modules.js
 */

const modules = [
    { name: 'acoustid', test: () => require('acoustid') },
    { name: 'essentia.js', test: () => require('essentia.js') },
    { name: 'music-metadata', test: () => require('music-metadata') },
    { name: 'node-id3', test: () => require('node-id3') },
    { name: '@tensorflow/tfjs', test: () => require('@tensorflow/tfjs') },
    { name: 'dotenv', test: () => require('dotenv') },
    { name: 'electron-store', test: () => require('electron-store') },
];

console.log('================================');
console.log('Native Module Loading Test');
console.log('================================\n');

let successCount = 0;
let failCount = 0;
const failures = [];

for (const module of modules) {
    process.stdout.write(`Testing ${module.name.padEnd(25)} ... `);

    try {
        const loaded = module.test();
        console.log('✓ OK');
        successCount++;

        // Additional checks
        if (module.name === 'acoustid') {
            // Check if fpcalc is available
            const { execSync } = require('child_process');
            try {
                execSync('which fpcalc', { stdio: 'ignore' });
                console.log('  → fpcalc binary found');
            } catch (e) {
                console.log('  ⚠ WARNING: fpcalc not found (brew install chromaprint)');
            }
        }

    } catch (error) {
        console.log(`✗ FAILED`);
        console.log(`  Error: ${error.message}`);
        failCount++;
        failures.push({ module: module.name, error: error.message });
    }
}

console.log('\n================================');
console.log('Results');
console.log('================================');
console.log(`✓ Success: ${successCount}`);
console.log(`✗ Failed:  ${failCount}`);

if (failures.length > 0) {
    console.log('\nFailed modules:');
    failures.forEach(f => {
        console.log(`  - ${f.module}: ${f.error}`);
    });

    console.log('\nRecommendations:');

    if (failures.some(f => f.module === 'acoustid')) {
        console.log('  • acoustid: Install chromaprint: brew install chromaprint');
        console.log('    Or disable in .env: #ACOUSTID_KEY=...');
    }

    console.log('  • Run: npm rebuild');
    console.log('  • Run: npm run bp:_clean');

    process.exit(1);
} else {
    console.log('\n✓ All modules loaded successfully!');
    console.log('If you still get SIGSEGV, the crash occurs during module usage, not loading.');
    console.log('Try: npm run start:debug:clean');
    process.exit(0);
}
