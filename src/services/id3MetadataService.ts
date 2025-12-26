import * as NodeID3 from 'node-id3';
import * as path from 'path';

export interface MoodMetadata {
    moodCode: string; // e.g., "36998"
    bpm: number; // e.g., 112
}

export interface BasicMetadata {
    artist: string;
    album: string;
    title: string;
    trackNumber?: string;
    bpm?: string;
}

// Write mood code and BPM to MP3 ID3 tags
export async function writeMoodMetadata(
    filePath: string,
    moodCode: string,
    bpm: number
): Promise<boolean> {
    try {
        const tags: NodeID3.Tags = {
            bpm: bpm.toString(),
            userDefinedText: [
                {
                    description: 'AMBIANCE_MOOD',
                    value: moodCode,
                },
            ],
        };

        // Wrap in setImmediate to prevent blocking event loop and potential SIGSEGV
        const result = await new Promise<boolean>((resolve, reject) => {
            setImmediate(() => {
                try {
                    const writeResult = NodeID3.write(tags, filePath);
                    resolve(writeResult === true);
                } catch (err) {
                    reject(err);
                }
            });
        });

        if (result) {
            console.log(`[ID3Metadata] Written mood=${moodCode} bpm=${bpm} to ${filePath}`);
        } else {
            console.error(`[ID3Metadata] Failed to write metadata to ${filePath}`);
        }
        return result;
    } catch (error: any) {
        console.error(`[ID3Metadata] Error writing metadata to ${filePath}:`, error.message);
        return false;
    }
}

// Read mood code and BPM from MP3 ID3 tags
export async function readMoodMetadata(filePath: string): Promise<MoodMetadata | null> {
    try {
        // Wrap in setImmediate to prevent blocking event loop
        const tags = await new Promise<any>((resolve, reject) => {
            setImmediate(() => {
                try {
                    const result = NodeID3.read(filePath);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });
        });

        if (!tags) {
            return null;
        }

        // Read BPM from standard BPM frame
        const bpm = tags.bpm ? parseInt(tags.bpm, 10) : null;

        // Read mood code from user-defined text frame
        let moodCode: string | null = null;
        if (tags.userDefinedText && Array.isArray(tags.userDefinedText)) {
            const moodFrame = tags.userDefinedText.find(
                (frame: any) => frame.description === 'AMBIANCE_MOOD'
            );
            if (moodFrame && moodFrame.value) {
                moodCode = moodFrame.value;
            }
        }

        // Return only if both are present
        if (moodCode && bpm) {
            console.log(`[ID3Metadata] Read mood=${moodCode} bpm=${bpm} from ${filePath}`);
            return {moodCode, bpm};
        }

        return null;
    } catch (error: any) {
        console.error(`[ID3Metadata] Error reading metadata from ${filePath}:`, error.message);
        return null;
    }
}

// Write basic metadata (artist, album, title, trackNumber, bpm) to MP3 ID3 tags
export async function writeBasicMetadata(
    filePath: string,
    metadata: BasicMetadata
): Promise<boolean> {
    try {
        const tags: NodeID3.Tags = {
            artist: metadata.artist,
            album: metadata.album,
            title: metadata.title,
        };

        if (metadata.trackNumber) {
            tags.trackNumber = metadata.trackNumber;
        }

        if (metadata.bpm) {
            tags.bpm = metadata.bpm;
        }

        // Wrap in setImmediate to prevent blocking event loop and potential SIGSEGV
        const result = await new Promise<boolean>((resolve, reject) => {
            setImmediate(() => {
                try {
                    const writeResult = NodeID3.write(tags, filePath);
                    resolve(writeResult === true);
                } catch (err) {
                    reject(err);
                }
            });
        });

        if (result) {
            console.log(`[ID3Metadata] Wrote ID3 tags to ${path.basename(filePath)}`);
        } else {
            console.error(`[ID3Metadata] Failed to write ID3 tags to ${path.basename(filePath)}`);
        }
        return result;
    } catch (error: any) {
        console.error(`[ID3Metadata] Error writing ID3 tags:`, error.message);
        return false;
    }
}
