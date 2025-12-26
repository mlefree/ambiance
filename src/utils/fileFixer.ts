import * as fs from 'fs';
import * as path from 'path';
import {fixMetadataOrder, hasIncorrectMetadataOrder} from './fileValidator';
import {extractMetadataFromFilename, findExistingFile} from './duplicateDetector';

export interface FixResult {
    fixed: boolean;
    action?: 'renamed' | 'removed_duplicate' | 'none';
    oldPath: string;
    newPath?: string;
    reason?: string;
}

/**
 * Automatically fixes organization issues in a file
 * - Fixes incorrect metadata order (B# before A#)
 * - Removes duplicates (keeps one, removes others)
 * Returns the corrected file path if changed
 */
export async function autoFixFile(filePath: string, baseFolder: string): Promise<FixResult> {
    const fileName = path.basename(filePath);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return {
            fixed: false,
            oldPath: filePath,
            reason: 'File does not exist',
        };
    }

    // Step 1: Fix incorrect metadata order (B# before A#)
    if (hasIncorrectMetadataOrder(fileName)) {
        const correctedName = fixMetadataOrder(fileName);
        if (correctedName) {
            const correctedPath = path.join(path.dirname(filePath), correctedName);
            console.log(`[FileFixer] Fixing metadata order: ${fileName} -> ${correctedName}`);

            if (!fs.existsSync(correctedPath)) {
                try {
                    fs.renameSync(filePath, correctedPath);
                    return {
                        fixed: true,
                        action: 'renamed',
                        oldPath: filePath,
                        newPath: correctedPath,
                        reason: 'Fixed incorrect metadata order (B# before A#)',
                    };
                } catch (error) {
                    console.error(`[FileFixer] Failed to rename:`, error);
                    return {
                        fixed: false,
                        oldPath: filePath,
                        reason: `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            } else {
                // Target already exists - this is likely a duplicate
                console.log(
                    `[FileFixer] Corrected file already exists, removing duplicate: ${fileName}`
                );
                try {
                    fs.unlinkSync(filePath);
                    return {
                        fixed: true,
                        action: 'removed_duplicate',
                        oldPath: filePath,
                        newPath: correctedPath,
                        reason: 'Removed duplicate (corrected version exists)',
                    };
                } catch (error) {
                    console.error(`[FileFixer] Failed to remove duplicate:`, error);
                    return {
                        fixed: false,
                        oldPath: filePath,
                        reason: `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            }
        }
    }

    // Step 2: Check for duplicates based on metadata
    const metadata = extractMetadataFromFilename(fileName);
    if (metadata) {
        const existingFile = findExistingFile(baseFolder, metadata);

        if (existingFile && path.resolve(existingFile) !== path.resolve(filePath)) {
            console.log(
                `[FileFixer] Found duplicate file: ${fileName} (original: ${path.basename(existingFile)})`
            );

            const existingMeta = extractMetadataFromFilename(path.basename(existingFile));

            // Determine which file to keep based on modification time
            const currentStats = fs.statSync(filePath);
            const existingStats = fs.statSync(existingFile);

            if (
                existingMeta &&
                (existingMeta.moods !== metadata.moods || existingMeta.bpm !== metadata.bpm)
            ) {
                // Different mood/BPM - keep the newer file, remove the older one
                if (currentStats.mtime > existingStats.mtime) {
                    // Current file is newer - remove the existing one
                    console.log(
                        `[FileFixer] Mood/BPM changed (${existingMeta.moods}/${existingMeta.bpm} -> ${metadata.moods}/${metadata.bpm}), removing older file`
                    );
                    try {
                        fs.unlinkSync(existingFile);
                        console.log(
                            `[FileFixer] Removed older version: ${path.basename(existingFile)}`
                        );
                        return {
                            fixed: false,
                            action: 'none',
                            oldPath: filePath,
                            reason: 'Kept newer version, removed older',
                        };
                    } catch (error) {
                        console.error(`[FileFixer] Failed to remove older file:`, error);
                    }
                } else {
                    // Existing file is newer - remove current file
                    console.log(
                        `[FileFixer] Found newer version (${existingMeta.moods}/${existingMeta.bpm}), removing older file`
                    );
                    try {
                        fs.unlinkSync(filePath);
                        return {
                            fixed: true,
                            action: 'removed_duplicate',
                            oldPath: filePath,
                            newPath: existingFile,
                            reason: 'Removed older version (newer exists)',
                        };
                    } catch (error) {
                        console.error(`[FileFixer] Failed to remove duplicate:`, error);
                        return {
                            fixed: false,
                            oldPath: filePath,
                            reason: `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
                        };
                    }
                }
            } else if (
                existingMeta &&
                existingMeta.moods === metadata.moods &&
                existingMeta.bpm === metadata.bpm
            ) {
                // Exact duplicate - remove current file
                console.log(`[FileFixer] Removing true duplicate: ${fileName}`);
                try {
                    fs.unlinkSync(filePath);
                    return {
                        fixed: true,
                        action: 'removed_duplicate',
                        oldPath: filePath,
                        newPath: existingFile,
                        reason: 'Removed true duplicate (identical metadata)',
                    };
                } catch (error) {
                    console.error(`[FileFixer] Failed to remove duplicate:`, error);
                    return {
                        fixed: false,
                        oldPath: filePath,
                        reason: `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            }
        }
    }

    // No fixes needed
    return {
        fixed: false,
        action: 'none',
        oldPath: filePath,
    };
}
