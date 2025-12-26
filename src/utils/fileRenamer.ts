import * as fs from 'fs';
import * as path from 'path';
import {generateFilenameWithMoodCode, hasMoodCode} from '../services/essentiaService';

export interface RenameResult {
    success: boolean;
    oldPath: string;
    newPath?: string;
    error?: string;
}

// Rename a file with mood classification code and BPM
export async function renameFileWithMoodCode(
    filePath: string,
    moodCode: string,
    bpm?: number
): Promise<RenameResult> {
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return {
                success: false,
                oldPath: filePath,
                error: 'File does not exist',
            };
        }

        const directory = path.dirname(filePath);
        const filename = path.basename(filePath);

        // Check if file already has a mood code (but allow A#55555 to be re-analyzed)
        if (hasMoodCode(filename) && !filename.includes('A#55555')) {
            console.log(`[FileRenamer] File already has mood code: ${filename}`);
            return {
                success: false,
                oldPath: filePath,
                error: 'File already has mood code',
            };
        }

        // If file has A#55555, we need to replace it, not append
        if (filename.includes('A#55555')) {
            console.log(
                `[FileRenamer] Replacing fallback mood code (A#55555) with real analysis: ${filename}`
            );
        }

        // Generate new filename
        const newFilename = generateFilenameWithMoodCode(filename, moodCode, bpm);
        const newPath = path.join(directory, newFilename);

        // Check if target filename already exists
        if (fs.existsSync(newPath)) {
            return {
                success: false,
                oldPath: filePath,
                error: 'Target filename already exists',
            };
        }

        // Rename the file
        fs.renameSync(filePath, newPath);

        console.log(`[FileRenamer] Renamed: ${filename} -> ${newFilename}`);

        return {
            success: true,
            oldPath: filePath,
            newPath: newPath,
        };
    } catch (error: any) {
        console.error('[FileRenamer] Error renaming file:', error);
        return {
            success: false,
            oldPath: filePath,
            error: error.message || 'Unknown error',
        };
    }
}
