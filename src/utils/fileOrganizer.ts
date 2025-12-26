import * as fs from 'fs';
import * as path from 'path';
import {extractMetadataFromFilename, findExistingFile} from './duplicateDetector';
import {fixMetadataOrder, hasIncorrectMetadataOrder} from './fileValidator';

export interface OrganizeResult {
    success: boolean;
    newPath?: string;
    error?: string;
    renamed?: boolean;
    removedDuplicate?: boolean;
}

/**
 * Sanitizes a string to be filesystem-safe
 */
function sanitizeForFilesystem(str: string): string {
    return str
        .replace(/[<>:"/\\|?*]/g, '_') // Replace forbidden characters
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
}

/**
 * Creates directory structure if it doesn't exist
 */
function ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, {recursive: true});
    }
}

/**
 * Generates the expected filename based on metadata
 */
export function generateOrganizedFilename(metadata: {
    artist: string;
    album: string;
    trackNumber: string;
    title: string;
    moods: string;
    bpm: string;
}): string {
    const {artist, album, trackNumber, title, moods, bpm} = metadata;

    // Sanitize each component
    const cleanArtist = sanitizeForFilesystem(artist);
    const cleanAlbum = sanitizeForFilesystem(album);
    const cleanTitle = sanitizeForFilesystem(title);

    // Format: <artist>-<album>-#<trackNumber>-<title>-A#<moods>-B#<bpm>.mp3
    return `${cleanArtist}-${cleanAlbum}-#${trackNumber}-${cleanTitle}-A#${moods}-B#${bpm}.mp3`;
}

/**
 * Moves a file to the organized directory structure
 * Creates <baseFolder>/<artist>/<album>/ directories if needed
 *
 * Handles:
 * - Duplicate detection and removal
 * - Mood code changes (renames instead of creating new file)
 * - Incorrect metadata order (B# before A#)
 */
export async function organizeFile(
    sourceFilePath: string,
    baseFolder: string,
    metadata: {
        artist: string;
        album: string;
        trackNumber: string;
        title: string;
        moods: string;
        bpm: string;
    }
): Promise<OrganizeResult> {
    try {
        if (!fs.existsSync(sourceFilePath)) {
            return {success: false, error: 'Source file does not exist'};
        }

        const sourceFileName = path.basename(sourceFilePath);
        const {artist, album} = metadata;

        // Step 1: Check if filename has incorrect metadata order (B# before A#)
        if (hasIncorrectMetadataOrder(sourceFileName)) {
            const correctedName = fixMetadataOrder(sourceFileName);
            if (correctedName) {
                const correctedPath = path.join(path.dirname(sourceFilePath), correctedName);
                console.log(
                    `[FileOrganizer] Fixing metadata order: ${sourceFileName} -> ${correctedName}`
                );

                if (!fs.existsSync(correctedPath)) {
                    // Use async rename to prevent SIGSEGV from concurrent file access
                    await fs.promises.rename(sourceFilePath, correctedPath);
                    sourceFilePath = correctedPath;
                }
            }
        }

        // Sanitize directory names
        const cleanArtist = sanitizeForFilesystem(artist);
        const cleanAlbum = sanitizeForFilesystem(album);

        // Create target directory structure
        const artistDir = path.join(baseFolder, cleanArtist);
        const albumDir = path.join(artistDir, cleanAlbum);

        ensureDirectoryExists(albumDir);

        // Step 2: Check if a file with same metadata already exists (potential duplicate)
        const existingFile = findExistingFile(baseFolder, {
            artist: cleanArtist,
            album: cleanAlbum,
            trackNumber: metadata.trackNumber,
            title: metadata.title,
        });

        if (existingFile && path.resolve(existingFile) !== path.resolve(sourceFilePath)) {
            console.log(`[FileOrganizer] Found existing file with same metadata: ${existingFile}`);

            const existingMeta = extractMetadataFromFilename(path.basename(existingFile));
            const newMoods = metadata.moods;
            const newBpm = metadata.bpm;

            // Check if mood codes or BPM differ
            if (existingMeta && (existingMeta.moods !== newMoods || existingMeta.bpm !== newBpm)) {
                // Mood or BPM changed - rename existing file instead of creating duplicate
                console.log(
                    `[FileOrganizer] Mood/BPM changed (${existingMeta.moods}/${existingMeta.bpm} -> ${newMoods}/${newBpm}), renaming existing file`
                );

                const updatedMetadata = {
                    ...metadata,
                    artist: cleanArtist,
                    album: cleanAlbum,
                };

                const newFileName = generateOrganizedFilename(updatedMetadata);
                const newPath = path.join(albumDir, newFileName);

                // Remove the old file (async to prevent SIGSEGV)
                await fs.promises.unlink(existingFile);

                // Remove the source file if it's different
                if (fs.existsSync(sourceFilePath)) {
                    await fs.promises.unlink(sourceFilePath);
                }

                // The file will be recreated by the caller with new metadata
                return {
                    success: true,
                    newPath: newPath,
                    renamed: true,
                };
            } else {
                // Same metadata including mood/BPM - this is a true duplicate
                console.log(`[FileOrganizer] Removing duplicate file: ${sourceFilePath}`);
                await fs.promises.unlink(sourceFilePath);
                return {
                    success: true,
                    newPath: existingFile,
                    removedDuplicate: true,
                };
            }
        }

        // Step 3: Generate target filename and move file
        const targetFilename = generateOrganizedFilename(metadata);
        const targetPath = path.join(albumDir, targetFilename);

        // Check if target already exists
        if (fs.existsSync(targetPath)) {
            // If source and target are the same, no need to move
            if (path.resolve(sourceFilePath) === path.resolve(targetPath)) {
                return {success: true, newPath: targetPath};
            }

            return {
                success: false,
                error: `Target file already exists: ${targetPath}`,
            };
        }

        // Move the file (async to prevent SIGSEGV from concurrent access)
        await fs.promises.rename(sourceFilePath, targetPath);

        return {success: true, newPath: targetPath};
    } catch (error) {
        return {
            success: false,
            error: `Failed to organize file: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Moves a file to the quarantine folder for manual review
 */
export async function quarantineFile(
    sourceFilePath: string,
    baseFolder: string,
    reason: string
): Promise<OrganizeResult> {
    try {
        if (!fs.existsSync(sourceFilePath)) {
            return {success: false, error: 'Source file does not exist'};
        }

        const quarantineDir = path.join(baseFolder, '_quarantine');
        ensureDirectoryExists(quarantineDir);

        const fileName = path.basename(sourceFilePath);
        const targetPath = path.join(quarantineDir, fileName);

        // If target exists, append timestamp to make it unique
        let finalPath = targetPath;
        if (fs.existsSync(targetPath)) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            const timestamp = Date.now();
            finalPath = path.join(quarantineDir, `${base}_${timestamp}${ext}`);
        }

        // Move the file (async to prevent SIGSEGV)
        await fs.promises.rename(sourceFilePath, finalPath);

        // Create a companion .txt file with the reason
        const reasonFile = `${finalPath}.reason.txt`;
        await fs.promises.writeFile(
            reasonFile,
            `Quarantined: ${new Date().toISOString()}\nReason: ${reason}\n`
        );

        console.log(`[Quarantine] ${fileName} -> ${finalPath}\nReason: ${reason}`);

        return {success: true, newPath: finalPath};
    } catch (error) {
        return {
            success: false,
            error: `Failed to quarantine file: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Checks if a file path is already in the organized structure
 */
export function isOrganized(filePath: string, baseFolder: string): boolean {
    const relativePath = path.relative(baseFolder, filePath);
    const parts = relativePath.split(path.sep);

    // Should have exactly 3 parts: artist, album, filename
    return parts.length === 3 && !parts[0].startsWith('_');
}
