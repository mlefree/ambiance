import * as path from 'path';
import {parseFile} from 'music-metadata';
import {AcoustIDService} from './acoustidService';
import {readMoodMetadata} from './id3MetadataService';
import {quarantineFile} from '../utils/fileOrganizer';
import {ExtractedMetadata} from './types/metadata';

export interface ExtractionResult {
    metadata: ExtractedMetadata | null;
    quarantined?: boolean;
}

// Extracts metadata from ID3 tags or AcoustID service
export class MetadataExtractor {
    private acoustidService: AcoustIDService | null = null;
    private isMockApiMode = false;

    constructor(acoustidService: AcoustIDService | null, isMockApiMode: boolean) {
        this.acoustidService = acoustidService;
        this.isMockApiMode = isMockApiMode;
    }

    async extract(filePath: string, baseFolder: string): Promise<ExtractionResult> {
        let artist = '';
        let album = '';
        let trackNumber = '';
        let title = '';
        let bpm = '';
        let genre = '';
        let fromAcoustID = false;
        let moodCode: string | undefined = undefined;

        // Read local ID3 metadata first
        const id3Result = await this.readID3Metadata(filePath);
        if (id3Result) {
            artist = id3Result.artist;
            title = id3Result.title;
            album = id3Result.album;
            trackNumber = id3Result.trackNumber;
            bpm = id3Result.bpm;
            genre = id3Result.genre;
            moodCode = id3Result.moodCode;
        }

        // If no metadata found in ID3 tags, try AcoustID (skip in mock-api mode)
        if ((!artist || !title) && this.acoustidService && !this.isMockApiMode) {
            const acoustidResult = await this.tryAcoustID(filePath, baseFolder);
            if (acoustidResult.quarantined) {
                return {metadata: null, quarantined: true};
            }
            if (acoustidResult.metadata) {
                artist = acoustidResult.metadata.artist;
                title = acoustidResult.metadata.title;
                album = acoustidResult.metadata.album;
                fromAcoustID = true;
            }
        }

        // If title is missing but we have artist, use filename as title
        if (artist && artist.trim() !== '' && (!title || title.trim() === '')) {
            const fileName = path.basename(filePath, '.mp3');
            title = fileName;
            console.log(
                `[MetadataExtractor] Using filename as title for ${fileName} (artist: ${artist})`
            );
        }

        // Fallback: use filename when no metadata found
        if (!artist || !title || artist.trim() === '' || title.trim() === '') {
            const fallbackFileName = path.basename(filePath, '.mp3');
            console.warn(
                `[MetadataExtractor] Missing metadata for ${fallbackFileName}, using filename as fallback`
            );

            const moodMetadata = await readMoodMetadata(filePath);

            return {
                metadata: {
                    artist: 'Unknown Artist',
                    album: 'Unknown Album',
                    trackNumber: '1',
                    title: fallbackFileName,
                    bpm: moodMetadata?.bpm.toString() || '120',
                    genre: 'Unknown',
                    fromAcoustID: false,
                    moodCode: moodMetadata?.moodCode,
                },
            };
        }

        return {
            metadata: {
                artist,
                album,
                trackNumber,
                title,
                bpm,
                genre,
                fromAcoustID,
                moodCode,
            },
        };
    }

    private async readID3Metadata(filePath: string): Promise<{
        artist: string;
        title: string;
        album: string;
        trackNumber: string;
        bpm: string;
        genre: string;
        moodCode?: string;
    } | null> {
        try {
            const metadata = await parseFile(filePath);
            const common = metadata.common;

            const artist = common.artist || '';
            const title = common.title || '';
            const album = common.album || 'Unknown';
            const trackNumber = common.track?.no?.toString() || '1';

            let bpm = '120';
            let moodCode: string | undefined = undefined;

            // Check for mood metadata in ID3 tags first
            const moodMetadata = await readMoodMetadata(filePath);
            if (moodMetadata) {
                console.log(
                    `[MetadataExtractor] Found mood metadata in ID3 for ${path.basename(filePath)}: mood=${moodMetadata.moodCode}, bpm=${moodMetadata.bpm}`
                );
                moodCode = moodMetadata.moodCode;
                bpm = moodMetadata.bpm.toString();
            } else {
                // Fallback to reading BPM from standard ID3 tags
                const bpmValue =
                    metadata.native?.ID3v2?.find((tag) => tag.id === 'TBPM')?.value ||
                    common.bpm ||
                    120;
                bpm =
                    typeof bpmValue === 'number'
                        ? bpmValue.toString()
                        : bpmValue?.toString() || '120';
            }

            const genreValue = Array.isArray(common.genre) ? common.genre[0] : common.genre;
            const genre = genreValue || 'Unknown';

            return {artist, title, album, trackNumber, bpm, genre, moodCode};
        } catch (error) {
            console.error(`[MetadataExtractor] Error reading local metadata:`, error);
            return null;
        }
    }

    private async tryAcoustID(
        filePath: string,
        baseFolder: string
    ): Promise<{
        metadata: {artist: string; title: string; album: string} | null;
        quarantined?: boolean;
    }> {
        if (!this.acoustidService || !this.acoustidService.isAvailable()) {
            if (this.acoustidService) {
                console.log(
                    `[MetadataExtractor] AcoustID rate-limited, will retry later: ${path.basename(filePath)}`
                );
            }
            return {metadata: null};
        }

        try {
            console.log(
                `[MetadataExtractor] No ID3 metadata for ${path.basename(filePath)}, trying AcoustID (rate limited to 1 call/minute)...`
            );
            const acoustidMeta = await this.acoustidService.getMetadata(filePath);

            if (acoustidMeta && acoustidMeta.artist && acoustidMeta.title) {
                console.log(
                    `[MetadataExtractor] Using AcoustID metadata for ${path.basename(filePath)}`
                );
                return {
                    metadata: {
                        artist: acoustidMeta.artist,
                        title: acoustidMeta.title,
                        album: acoustidMeta.album || 'Unknown',
                    },
                };
            } else {
                const reason = `No metadata found (AcoustID lookup returned no results)`;
                console.log(
                    `[MetadataExtractor] ${reason} for ${path.basename(filePath)} => quarantine`
                );
                const quarantineResult = await quarantineFile(filePath, baseFolder, reason);
                if (quarantineResult.success) {
                    return {metadata: null, quarantined: true};
                }
            }
        } catch (error) {
            console.warn(`[MetadataExtractor] AcoustID lookup failed:`, error);
        }

        return {metadata: null};
    }
}
