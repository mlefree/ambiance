import * as fs from 'fs';
import * as path from 'path';

export interface FileInfo {
    filePath: string;
    artist: string;
    album: string;
    trackNumber: string;
    title: string;
    bpm: string;
    moods: string;
}

/**
 * Extracts metadata from filename that follows the standard format
 */
export function extractMetadataFromFilename(fileName: string): {
    artist: string;
    album: string;
    trackNumber: string;
    title: string;
    moods: string;
    bpm: string;
} | null {
    // Match standard format: <artist>-<album>-#<track>-<title>-A#<moods>-B#<bpm>.mp3
    const regex = /^(.+)-(.+)-#(\d+)-(.+)-A#(\d{5})-B#(\d+)\.mp3$/;
    const match = fileName.match(regex);

    if (!match) {
        return null;
    }

    const [, artist, album, trackNumber, title, moods, bpm] = match;

    return {
        artist,
        album,
        trackNumber,
        title,
        moods,
        bpm,
    };
}

/**
 * Checks if a file with the same metadata already exists (potential duplicate)
 * Returns the existing file path if found
 */
export function findExistingFile(
    baseFolder: string,
    metadata: {
        artist: string;
        album: string;
        trackNumber: string;
        title: string;
    }
): string | null {
    const artistDir = path.join(baseFolder, metadata.artist);
    const albumDir = path.join(artistDir, metadata.album);

    if (!fs.existsSync(albumDir)) {
        return null;
    }

    const files = fs.readdirSync(albumDir);

    for (const file of files) {
        if (!file.endsWith('.mp3')) {
            continue;
        }

        const fileMeta = extractMetadataFromFilename(file);
        if (!fileMeta) {
            continue;
        }

        if (
            fileMeta.artist.toLowerCase() === metadata.artist.toLowerCase() &&
            fileMeta.album.toLowerCase() === metadata.album.toLowerCase() &&
            fileMeta.trackNumber === metadata.trackNumber &&
            fileMeta.title.toLowerCase() === metadata.title.toLowerCase()
        ) {
            return path.join(albumDir, file);
        }
    }

    return null;
}
