import * as path from 'path';
import {AcoustIDService} from './acoustidService';
import {
    hasFallbackMoodCode,
    hasUnknownMetadata,
    validateFile,
    validateMP3Format,
} from '../utils/fileValidator';
import {organizeFile, quarantineFile} from '../utils/fileOrganizer';
import {writeBasicMetadata, writeMoodMetadata} from './id3MetadataService';
import {MetadataExtractor} from './metadataExtractor';
import {
    ExtractedMetadata,
    FileMetadata,
    MetadataExtractionResult,
    ProcessingResult,
} from './types/metadata';

// Re-export types for backwards compatibility
export {ExtractedMetadata, FileMetadata, MetadataExtractionResult, ProcessingResult};

// Service for processing files: validation, metadata extraction, mood analysis, and organization
export class FileProcessor {
    private acoustidServiceInitiated = false;
    private acoustidService: AcoustIDService | null = null;
    private metadataExtractor: MetadataExtractor;
    private isMockApiMode = false;

    constructor(acoustidApiKey?: string, isMockApiMode = false) {
        this.isMockApiMode = isMockApiMode;

        if (this.isMockApiMode) {
            console.log('[FileProcessor] Running in MOCK-API mode (no AcoustID calls)');
        } else if (acoustidApiKey && acoustidApiKey.trim() !== '') {
            if (!this.acoustidServiceInitiated) {
                this.acoustidServiceInitiated = true;
                this.acoustidService = new AcoustIDService(acoustidApiKey);
                console.log(
                    '[FileProcessor] AcoustID service initialized with 1 call/minute rate limit'
                );
            }
        } else {
            console.log('[FileProcessor] No AcoustID key configured, will use ID3 tags only');
        }

        this.metadataExtractor = new MetadataExtractor(this.acoustidService, this.isMockApiMode);
    }

    // Extract metadata only (for batch processing - step 1)
    async extractFileMetadata(
        filePath: string,
        baseFolder: string
    ): Promise<MetadataExtractionResult> {
        console.log(`[FileProcessor] Extracting metadata: ${path.basename(filePath)}`);

        // Step 1: Validate MP3 format
        const formatValidation = await validateMP3Format(filePath);
        if (!formatValidation.isValid) {
            const reason = `Invalid MP3 format: ${formatValidation.errors.join(', ')}`;
            console.error(`[FileProcessor] ${reason}`);
            const quarantineResult = await quarantineFile(filePath, baseFolder, reason);
            return {
                success: false,
                error: reason,
                quarantined: quarantineResult.success,
            };
        }

        // Step 2: Check if already validated and organized
        const fileName = path.basename(filePath);
        const fileValidation = await validateFile(filePath, baseFolder);
        const needsMoodsReAnalysis = hasFallbackMoodCode(fileName);
        const needsMetadataReAnalysis = hasUnknownMetadata(filePath);

        if (
            fileValidation.isValid &&
            fileValidation.metadata &&
            !needsMoodsReAnalysis &&
            !needsMetadataReAnalysis
        ) {
            console.log(`[FileProcessor] File already organized: ${fileName}`);
            return {
                success: true,
                metadata: {
                    artist: fileValidation.metadata.artist,
                    album: fileValidation.metadata.album,
                    trackNumber: fileValidation.metadata.trackNumber,
                    title: fileValidation.metadata.title,
                    bpm: fileValidation.metadata.bpm,
                    genre: 'Unknown',
                    fromAcoustID: false,
                    moodCode: fileValidation.metadata.moods,
                },
            };
        }

        // Step 3: Extract metadata from ID3 tags (includes genre and moodCode)
        const extractionResult = await this.metadataExtractor.extract(filePath, baseFolder);
        if (extractionResult.quarantined) {
            return {
                success: false,
                error: 'File quarantined: no metadata found',
                quarantined: true,
            };
        }
        const metadata = extractionResult.metadata;

        // MetadataExtractor always returns metadata (with fallback), but check for safety
        if (!metadata) {
            return {
                success: false,
                error: 'Failed to extract metadata',
            };
        }

        // Step 4: Write metadata back to file if from AcoustID
        if (metadata.fromAcoustID) {
            await writeBasicMetadata(filePath, {
                artist: metadata.artist,
                album: metadata.album,
                title: metadata.title,
                trackNumber: metadata.trackNumber,
                bpm: metadata.bpm,
            });
        }

        return {
            success: true,
            metadata,
        };
    }

    // Organize file with provided metadata and mood (for batch processing - step 2)
    async organizeFileWithMetadata(
        filePath: string,
        baseFolder: string,
        metadata: ExtractedMetadata,
        moodCode: string,
        bpm: string
    ): Promise<ProcessingResult> {
        console.log(`[FileProcessor] Organizing with mood: ${path.basename(filePath)}`);

        const fileMetadata: FileMetadata = {
            artist: metadata.artist,
            album: metadata.album,
            trackNumber: metadata.trackNumber,
            title: metadata.title,
            bpm: bpm,
            moods: moodCode,
        };

        const organizeResult = await organizeFile(filePath, baseFolder, fileMetadata);

        if (!organizeResult.success) {
            const reason = `Failed to organize: ${organizeResult.error}`;
            console.error(`[FileProcessor] ${reason}`);
            const quarantineResult = await quarantineFile(filePath, baseFolder, reason);
            return {
                success: false,
                error: reason,
                quarantined: quarantineResult.success,
            };
        }

        // Write mood metadata to ID3 tags of the organized file
        if (organizeResult.newPath) {
            const bpmNumber = parseInt(bpm, 10) || 120;
            await writeMoodMetadata(organizeResult.newPath, moodCode, bpmNumber);
        }

        console.log(`[FileProcessor] Successfully organized: ${path.basename(filePath)}`);
        return {
            success: true,
            organizedPath: organizeResult.newPath,
        };
    }
}
