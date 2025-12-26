import * as fs from 'fs';
import * as path from 'path';

export interface MP3Info {
    filePath: string;
    fileName: string;
    directory: string;
}

export function findAllMP3sRecursive(
    directory: string,
    excludeDirs: string[] = ['_quarantine']
): MP3Info[] {
    const mp3Files: MP3Info[] = [];

    function scanDirectory(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                return;
            }

            const entries = fs.readdirSync(dir, {withFileTypes: true});

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Skip excluded directories
                    if (!excludeDirs.includes(entry.name)) {
                        scanDirectory(fullPath);
                    }
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
                    mp3Files.push({
                        filePath: fullPath,
                        fileName: entry.name,
                        directory: dir,
                    });
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${dir}:`, error);
        }
    }

    scanDirectory(directory);
    console.log(`Found ${mp3Files.length} MP3 files recursively in: ${directory}`);
    return mp3Files;
}

// Remove empty directories recursively (bottom-up)
export function removeEmptyDirectories(
    directory: string,
    excludeDirs: string[] = ['_quarantine']
): number {
    let removedCount = 0;

    function isDirectoryEmpty(dir: string): boolean {
        try {
            const entries = fs.readdirSync(dir);
            return entries.length === 0;
        } catch (error) {
            console.error(`Error checking if directory is empty ${dir}:`, error);
            return false;
        }
    }

    function cleanDirectory(dir: string): void {
        try {
            if (!fs.existsSync(dir)) {
                return;
            }

            const entries = fs.readdirSync(dir, {withFileTypes: true});

            // First, recursively clean subdirectories
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const fullPath = path.join(dir, entry.name);
                    // Skip excluded directories
                    if (!excludeDirs.includes(entry.name)) {
                        cleanDirectory(fullPath);
                    }
                }
            }

            // After cleaning subdirectories, check if current directory is empty
            // (but don't remove the root directory itself)
            if (dir !== directory && isDirectoryEmpty(dir)) {
                fs.rmdirSync(dir);
                console.log(`Removed empty directory: ${dir}`);
                removedCount++;
            }
        } catch (error) {
            console.error(`Error cleaning directory ${dir}:`, error);
        }
    }

    cleanDirectory(directory);
    if (removedCount > 0) {
        console.log(`Removed ${removedCount} empty directories in: ${directory}`);
    }
    return removedCount;
}
