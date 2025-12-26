import * as fs from 'fs';
import * as path from 'path';
import {findAllMP3sRecursive, removeEmptyDirectories} from '../utils/mp3Finder';
import {ExtractedMetadata, FileProcessor} from './fileProcessor';
import {isOrganized, quarantineFile} from '../utils/fileOrganizer';
import {autoFixFile} from '../utils/fileFixer';
import {
    DEFAULT_MOOD_MODES,
    hasFallbackMoodCode,
    hasUnknownMetadata,
    isFullyCompliant,
    matchesMoodMode,
    MoodMode,
    MoodModeDefinition,
} from '../utils/fileValidator';

export interface ListenedTrack {
    filePath: string;
    listenedAt: string; // ISO timestamp
}

export {MoodMode, MoodModeDefinition} from '../utils/fileValidator';

export interface AmbianceData {
    tracks: ListenedTrack[]; // Listen history
    playlist: string[]; // Array of validated file paths
    toProcess?: string[]; // Files that need processing
    moodMode?: MoodMode; // UI mood filter selection
    moodModes?: MoodModeDefinition[]; // Available mood mode definitions with rules
}

// Batch analysis result from renderer
export interface MoodBatchResult {
    filePath: string;
    success: boolean;
    moodCode?: string;
    bpm?: number;
    error?: string;
}

// File ready for organization (metadata + mood extracted)
interface AnalyzedFile {
    filePath: string;
    metadata: ExtractedMetadata;
    moodCode: string;
    bpm: string;
}

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lazy playlist tracker - maintains a small playlist and processes files in batches
 * New flow: discover -> analyze batch -> organize batch -> build playlist
 */
export class PlaylistTrackerLazy {
    private readonly musicFolder: string;
    private readonly ambianceFilePath: string;
    private data: AmbianceData;
    private updateCycleInterval: NodeJS.Timeout | null = null;
    private readonly fileProcessor: FileProcessor;
    private readonly maxPlaylistSize = 20;
    private readonly discoveryTriggerSize = 10;
    private onPlaylistChange?: (songWasConsumed?: boolean) => void;
    private readonly isMockMode: boolean;
    private readonly isMockApiMode: boolean;
    private onRequestMoodBatchAnalysis?: (
        filePaths: string[]
    ) => Promise<Map<string, MoodBatchResult>>;

    private moodMode: MoodMode = 'all';
    private moodModes: MoodModeDefinition[] = DEFAULT_MOOD_MODES;

    // lists for analysis
    private processedFiles: Set<string> = new Set();
    private pendingMoodAnalysis: Map<string, ExtractedMetadata> = new Map();
    private inFlightMoodAnalysis: Set<string> = new Set();
    private analyzedFiles: Map<string, AnalyzedFile> = new Map();

    constructor(musicFolder: string, acoustidApiKey?: string) {
        this.musicFolder = musicFolder;
        this.ambianceFilePath = path.join(musicFolder, 'ambiance.json');
        this.isMockMode = process.env.MODE === 'mock-all';
        this.isMockApiMode = process.env.MODE === 'mock-api';
        this.data = this.loadOrCreateAmbianceFile();
        this.moodMode = this.data.moodMode || 'all'; // Restore from ambiance.json
        this.moodModes = this.data.moodModes || DEFAULT_MOOD_MODES; // Restore from ambiance.json
        this.fileProcessor = new FileProcessor(acoustidApiKey, this.isMockApiMode);

        this.logMockModeStatus();
    }

    setOnPlaylistChange(callback: (songWasConsumed?: boolean) => void): void {
        this.onPlaylistChange = callback;
    }

    setOnRequestMoodBatchAnalysis(
        callback: (filePaths: string[]) => Promise<Map<string, MoodBatchResult>>
    ): void {
        this.onRequestMoodBatchAnalysis = callback;
    }

    // Get current mood mode (loaded from ambiance.json)
    getMoodMode(): MoodMode {
        return this.moodMode;
    }

    // Get available mood mode definitions (loaded from ambiance.json)
    getMoodModes(): MoodModeDefinition[] {
        return this.moodModes;
    }

    // Set mood mode filter and clear playlist to refill with matching songs
    setMoodMode(mode: MoodMode): void {
        if (this.moodMode !== mode) {
            console.log(`[PlaylistTrackerLazy] Mood mode changed: ${this.moodMode} -> ${mode}`);
            this.moodMode = mode;
            this.data.moodMode = mode; // Persist to ambiance.json
            // Clear playlist to force refill with songs matching the new mood
            this.data.playlist = [];
            this.saveAmbianceFile();
            // Trigger immediate update cycle to refill playlist
            this.updateCycle().then(() => {
                if (this.onPlaylistChange) {
                    this.onPlaylistChange();
                }
            });
        }
    }

    // Set mood modes definitions (for future editing feature)
    setMoodModes(modes: MoodModeDefinition[]): void {
        this.moodModes = modes;
        this.data.moodModes = modes;
        this.saveAmbianceFile();
        console.log(
            `[PlaylistTrackerLazy] Mood modes updated: ${modes.map((m) => m.name).join(', ')}`
        );
    }

    // Start background thread that maintains the playlist
    async start() {
        console.log('[PlaylistTrackerLazy] Starting lazy playlist tracker');

        // Delay initial start to allow renderer/TensorFlow to fully initialize
        // This prevents SIGSEGV race condition during model loading
        await sleep(5000);
        console.log('[PlaylistTrackerLazy] Starting update cycle after initial delay');

        // Initial discovery and processing
        this.saveAmbianceFile();
        await this.discoverPendingFiles();
        await this.updateCycle();

        // Update Cycle every 3 seconds (slower to prevent SIGSEGV with native modules)
        this.updateCycleInterval = setInterval(() => {
            this.updateCycle().catch((error) => {
                console.error('[PlaylistTrackerLazy] Error in updateCycle:', error);
            });
        }, 3000);
    }

    // Stop background thread
    stop(): void {
        if (this.updateCycleInterval) {
            clearInterval(this.updateCycleInterval);
            this.updateCycleInterval = null;
            console.log('[PlaylistTrackerLazy] Stopped lazy playlist tracker');
        }
    }

    // Track that a file was listened to (just for history, don't remove yet)
    trackListen(filePath: string): void {
        const listenedTrack: ListenedTrack = {
            filePath,
            listenedAt: new Date().toISOString(),
        };

        this.data.tracks.push(listenedTrack);

        // Limit tracks history to maxPlaylistSize (keep most recent)
        if (this.data.tracks.length > this.maxPlaylistSize) {
            this.data.tracks = this.data.tracks.slice(-this.maxPlaylistSize);
        }

        this.saveAmbianceFile();
        console.log('[PlaylistTrackerLazy] Tracked listen:', filePath);
    }

    // Remove song from playlist when moving to next (consumption queue)
    consumeSong(filePath: string): void {
        const fileName = path.basename(filePath);

        // REMOVE from playlist (consumption queue behavior)
        const index = this.data.playlist.indexOf(filePath);
        if (index !== -1) {
            this.data.playlist.splice(index, 1);
            console.log(
                `[PlaylistTrackerLazy] Consumed (removed) song from playlist: ${fileName} (${this.data.playlist.length} remaining)`
            );

            this.saveAmbianceFile();

            // Notify that playlist changed (song was consumed)
            if (this.onPlaylistChange) {
                this.onPlaylistChange(true); // Pass true to indicate consumption
            }

            // Trigger immediate refill check if playlist is getting low
            if (this.data.playlist.length < 10) {
                console.log('[PlaylistTrackerLazy] Playlist low, triggering refill...');
                this.updateCycle();
            }
        }
    }

    getPlaylist(): string[] {
        return this.data.playlist;
    }

    getHistory(): ListenedTrack[] {
        return this.data.tracks;
    }

    updateFilePathInToProcess(oldPath: string, newPath: string): void {
        if (!this.data.toProcess) {
            return;
        }

        const index = this.data.toProcess.indexOf(oldPath);
        if (index !== -1) {
            this.data.toProcess[index] = newPath;
            console.log(
                `[PlaylistTrackerLazy] Updated toProcess: ${path.basename(oldPath)} -> ${path.basename(newPath)}`
            );
            this.saveAmbianceFile();
        }
    }

    getStats(): {
        playlistSize: number;
        toProcessCount: number;
        processedCount: number;
        totalListens: number;
        inFlightCount: number;
    } {
        return {
            playlistSize: this.data.playlist.length,
            toProcessCount: this.data.toProcess?.length || 0,
            processedCount: this.processedFiles.size,
            totalListens: this.data.tracks.length,
            inFlightCount: this.inFlightMoodAnalysis.size,
        };
    }

    private logMockModeStatus(): void {
        const modeMessages: Record<string, string> = {
            'mock-all': 'MOCK-ALL mode (no API calls, no file modifications)',
            'mock-api': 'MOCK-API mode (no API calls, but file modifications allowed)',
            'mock-user': 'MOCK-USER mode (API calls allowed with 1 call/minute rate limit)',
        };
        const mode = process.env.MODE;
        if (mode && modeMessages[mode]) {
            console.log(`[PlaylistTrackerLazy] Running in ${modeMessages[mode]}`);
        }
    }

    private loadOrCreateAmbianceFile(): AmbianceData {
        try {
            if (fs.existsSync(this.ambianceFilePath)) {
                const content = fs.readFileSync(this.ambianceFilePath, 'utf-8');
                const data = JSON.parse(content);

                return {
                    tracks: data.tracks || [],
                    playlist: data.playlist || [],
                    toProcess: data.toProcess || [],
                    moodMode: data.moodMode || 'all',
                    moodModes: data.moodModes || DEFAULT_MOOD_MODES,
                };
            }
        } catch (error) {
            console.error('[PlaylistTrackerLazy] Error loading ambiance.json:', error);
        }

        // Create default structure
        return {
            tracks: [],
            playlist: [],
            toProcess: [],
            moodMode: 'all',
            moodModes: DEFAULT_MOOD_MODES,
        };
    }

    private saveAmbianceFile(): void {
        try {
            fs.writeFileSync(this.ambianceFilePath, JSON.stringify(this.data, null, 2), 'utf-8');
            console.log('[PlaylistTrackerLazy] Saved ambiance.json');
        } catch (error) {
            console.error('[PlaylistTrackerLazy] Error saving ambiance.json:', error);
        }
    }

    private async discoverPendingFiles(): Promise<void> {
        console.log('[PlaylistTrackerLazy] Discovering pending files...');
        const allFiles = findAllMP3sRecursive(this.musicFolder);

        if (this.isMockMode) {
            this.discoverMockAllMode(allFiles);
            return;
        }

        if (this.isMockApiMode) {
            this.discoverMockApiMode(allFiles);
            return;
        }

        await this.discoverNormalMode(allFiles);
    }

    // Categorize files into organized/unorganized lists
    private categorizeFiles(
        allFiles: {filePath: string}[],
        skipProcessed: boolean
    ): {organized: string[]; unorganized: string[]} {
        const organized: string[] = [];
        const unorganized: string[] = [];

        for (const mp3 of allFiles) {
            const filePath = mp3.filePath;
            if (skipProcessed && this.processedFiles.has(filePath)) {
                continue;
            }
            if (isOrganized(filePath, this.musicFolder)) {
                organized.push(filePath);
            } else {
                unorganized.push(filePath);
            }
        }
        return {organized, unorganized};
    }

    // Add files to queue with limit
    private addToQueueWithLimit(queue: string[], files: string[], maxSize: number): string[] {
        const remainingSlots = maxSize - queue.length;
        return files.slice(0, remainingSlots);
    }

    private discoverMockAllMode(allFiles: {filePath: string}[]): void {
        console.log(
            '[PlaylistTrackerLazy] MOCK-ALL mode: categorizing files without modifications'
        );
        const {organized, unorganized} = this.categorizeFiles(allFiles, false);

        this.data.playlist = organized.slice(0, this.maxPlaylistSize);
        this.data.toProcess = unorganized.slice(0, this.maxPlaylistSize);

        console.log(
            `[PlaylistTrackerLazy] MOCK-ALL: ${organized.length} organized (using ${this.data.playlist.length}), ${unorganized.length} unorganized (using ${this.data.toProcess.length})`
        );

        this.saveAmbianceFile();
        this.onPlaylistChange?.();
    }

    private discoverMockApiMode(allFiles: {filePath: string}[]): void {
        console.log(
            '[PlaylistTrackerLazy] MOCK-API mode: categorizing files, modifications allowed'
        );
        const {organized, unorganized} = this.categorizeFiles(allFiles, true);

        const organizedToAdd = this.addToQueueWithLimit(
            this.data.playlist,
            organized,
            this.maxPlaylistSize
        );
        this.data.playlist.push(...organizedToAdd);

        if (!this.data.toProcess) {
            this.data.toProcess = [];
        }
        const unorganizedToAdd = this.addToQueueWithLimit(
            this.data.toProcess,
            unorganized,
            this.maxPlaylistSize
        );
        this.data.toProcess.push(...unorganizedToAdd);

        console.log(
            `[PlaylistTrackerLazy] MOCK-API: ${organized.length} organized (using ${this.data.playlist.length}), ${unorganized.length} unorganized (using ${this.data.toProcess.length})`
        );

        this.onPlaylistChange?.();
    }

    private async discoverNormalMode(allFiles: {filePath: string}[]): Promise<void> {
        const categorized = await this.categorizeFilesWithAutoFix(allFiles);

        this.cleanupAfterFixes(categorized.fixedCount);
        this.populateQueuesFromCategorized(categorized);
    }

    private async categorizeFilesWithAutoFix(allFiles: {filePath: string}[]): Promise<{
        organized: string[];
        unorganized: string[];
        fallbackMood: string[];
        fixedCount: number;
    }> {
        const organized: string[] = [];
        const unorganized: string[] = [];
        const fallbackMood: string[] = [];
        let fixedCount = 0;

        for (const mp3 of allFiles) {
            let filePath = mp3.filePath;

            const fixResult = await autoFixFile(filePath, this.musicFolder);
            if (fixResult.fixed) {
                fixedCount++;
                if (fixResult.action === 'removed_duplicate') {
                    console.log(
                        `[PlaylistTrackerLazy] Skipping removed duplicate: ${path.basename(filePath)}`
                    );
                    continue;
                } else if (fixResult.action === 'renamed' && fixResult.newPath) {
                    filePath = fixResult.newPath;
                    console.log(
                        `[PlaylistTrackerLazy] Using renamed file: ${path.basename(filePath)}`
                    );
                }
            }

            if (!fs.existsSync(filePath)) {
                continue;
            }

            const category = this.determineFileCategory(filePath);
            if (!category) {
                continue;
            }

            switch (category) {
                case 'organized':
                    organized.push(filePath);
                    break;
                case 'unorganized':
                    unorganized.push(filePath);
                    break;
                case 'fallback-mood':
                    fallbackMood.push(filePath);
                    break;
            }
        }

        return {organized, unorganized, fallbackMood, fixedCount};
    }

    private determineFileCategory(
        filePath: string
    ): 'organized' | 'unorganized' | 'fallback-mood' | null {
        const fileName = path.basename(filePath);
        const needsMoodReAnalysis = hasFallbackMoodCode(fileName);
        const needsMetadataReAnalysis = hasUnknownMetadata(filePath);
        const needsReAnalysis = needsMoodReAnalysis || needsMetadataReAnalysis;

        // Skip if already queued (unless needs re-analysis)
        if (!needsReAnalysis && this.isFileAlreadyQueued(filePath)) {
            return null;
        }

        // Remove from playlist if it has Unknown metadata
        if (needsMetadataReAnalysis) {
            this.removeFromPlaylistIfPresent(filePath, 'Unknown metadata');
        }

        if (isOrganized(filePath, this.musicFolder)) {
            if (needsMetadataReAnalysis) {
                console.log(
                    `[PlaylistTrackerLazy] File needs metadata: ${path.basename(filePath)}`
                );
                return 'unorganized';
            } else if (needsMoodReAnalysis) {
                console.log(
                    `[PlaylistTrackerLazy] File needs mood analysis: ${path.basename(filePath)}`
                );
                return 'fallback-mood';
            }
            return 'organized';
        }

        if (!this.processedFiles.has(filePath)) {
            return 'unorganized';
        }
        return null;
    }

    private isFileAlreadyQueued(filePath: string): boolean {
        return this.data.toProcess?.includes(filePath) || this.data.playlist.includes(filePath);
    }

    private removeFromPlaylistIfPresent(filePath: string, reason: string): void {
        const idx = this.data.playlist.indexOf(filePath);
        if (idx !== -1) {
            this.data.playlist.splice(idx, 1);
            console.log(
                `[PlaylistTrackerLazy] Removed from playlist (${reason}): ${path.basename(filePath)}`
            );
        }
    }

    private cleanupAfterFixes(fixedCount: number): void {
        if (fixedCount > 0) {
            console.log(`[PlaylistTrackerLazy] Auto-fixed ${fixedCount} organization issues`);
        }
        const removedDirs = removeEmptyDirectories(this.musicFolder);
        if (removedDirs > 0) {
            console.log(`[PlaylistTrackerLazy] Cleaned up ${removedDirs} empty directories`);
        }
    }

    private populateQueuesFromCategorized(categorized: {
        organized: string[];
        unorganized: string[];
        fallbackMood: string[];
    }): void {
        if (!this.data.toProcess) {
            this.data.toProcess = [];
        }

        // Add unorganized files to toProcess
        if (categorized.unorganized.length > 0) {
            const toAdd = this.addToQueueWithLimit(
                this.data.toProcess,
                categorized.unorganized,
                this.maxPlaylistSize
            );
            this.data.toProcess.push(...toAdd);
            console.log(
                `[PlaylistTrackerLazy] Unorganized: ${categorized.unorganized.length} found, ${toAdd.length} added (queue: ${this.data.toProcess.length}/${this.maxPlaylistSize})`
            );
        }

        // Add fallback mood files to toProcess
        if (categorized.fallbackMood.length > 0) {
            const toAdd = this.addToQueueWithLimit(
                this.data.toProcess,
                categorized.fallbackMood,
                this.maxPlaylistSize
            );
            this.data.toProcess.push(...toAdd);
            console.log(
                `[PlaylistTrackerLazy] Fallback mood: ${categorized.fallbackMood.length} found, ${toAdd.length} added (queue: ${this.data.toProcess.length}/${this.maxPlaylistSize})`
            );
        }

        // Add organized files to playlist (filtered by mood)
        if (categorized.organized.length > 0) {
            const filtered = categorized.organized.filter((f) =>
                matchesMoodMode(f, this.moodMode, this.moodModes)
            );
            const toAdd = this.addToQueueWithLimit(
                this.data.playlist,
                filtered,
                this.maxPlaylistSize
            );
            this.data.playlist.push(...toAdd);
            console.log(
                `[PlaylistTrackerLazy] Organized: ${categorized.organized.length} found, ${filtered.length} match mood "${this.moodMode}", ${toAdd.length} added (playlist: ${this.data.playlist.length}/${this.maxPlaylistSize})`
            );

            this.onPlaylistChange?.();
        }
    }

    // Main update cycle - runs every 3 seconds
    // New flow: when playlist <= 10, pick random 10 files -> check compliance -> compliant to playlist, non-compliant to toProcess
    private async updateCycle(): Promise<void> {
        // Skip in mock-all mode - everything done in discoverPendingFiles
        if (this.isMockMode) {
            return;
        }

        try {
            const currentSize = this.data.playlist.length;
            let hasChanges = false;

            // Step 1: When playlist is at or below trigger size, discover more files
            if (currentSize <= this.discoveryTriggerSize) {
                const neededFiles = this.maxPlaylistSize - currentSize;
                hasChanges = (await this.checkRandomBatch(neededFiles)) || hasChanges;
            }

            // Step 2: Extract metadata for batch of files needing processing
            const batchSize = this.discoveryTriggerSize;
            if (
                this.pendingMoodAnalysis.size < batchSize &&
                this.data.toProcess &&
                this.data.toProcess.length > 0
            ) {
                await this.extractMetadataBatch();
                hasChanges = true;
            }

            // Step 3: Request mood analysis for pending files (if we have any)
            if (this.pendingMoodAnalysis.size > 0 && this.analyzedFiles.size < batchSize) {
                await this.analyzeMoodBatch();
            }

            // Step 4: Organize analyzed files (if we have any)
            if (this.analyzedFiles.size > 0) {
                await this.organizeBatch();
                hasChanges = true;
            }

            // Log status
            console.log(
                `[PlaylistTrackerLazy] Update cycle - playlist: ${this.data.playlist.length}/${this.maxPlaylistSize}, toProcess: ${this.data.toProcess?.length || 0}, pendingMood: ${this.pendingMoodAnalysis.size}, analyzed: ${this.analyzedFiles.size}`
            );

            // Save state only if something changed
            if (hasChanges) {
                this.saveAmbianceFile();
            }
        } catch (error) {
            console.error('[PlaylistTrackerLazy] Error in update cycle:', error);
        }
    }

    // Pick random batch of files from all directories and check compliance
    // Returns true if any changes were made
    private async checkRandomBatch(count: number): Promise<boolean> {
        // Get all MP3 files
        const allFiles = findAllMP3sRecursive(this.musicFolder);
        if (allFiles.length === 0) {
            return false;
        }

        // Shuffle and pick random batch
        const shuffled = allFiles.sort(() => Math.random() - 0.5);
        const batch = shuffled.slice(0, count);

        let addedToPlaylist = 0;
        let addedToProcess = 0;

        for (const mp3Info of batch) {
            const filePath = mp3Info.filePath;

            // Skip if file doesn't exist
            if (!fs.existsSync(filePath)) {
                continue;
            }

            // Skip if already in playlist
            if (this.data.playlist.includes(filePath)) {
                continue;
            }

            // Skip if already being processed
            if (
                this.data.toProcess?.includes(filePath) ||
                this.pendingMoodAnalysis.has(filePath) ||
                this.analyzedFiles.has(filePath) ||
                this.inFlightMoodAnalysis.has(filePath)
            ) {
                continue;
            }

            // Check if fully compliant
            if (isFullyCompliant(filePath, this.musicFolder)) {
                // Filter by mood mode (based on A# code in filename)
                if (!matchesMoodMode(filePath, this.moodMode, this.moodModes)) {
                    continue;
                }
                // Add to playlist if there's room
                if (this.data.playlist.length < this.maxPlaylistSize) {
                    this.data.playlist.push(filePath);
                    addedToPlaylist++;
                }
            } else {
                // Not compliant - add to toProcess for metadata extraction
                if (!this.data.toProcess) {
                    this.data.toProcess = [];
                }
                if (!this.data.toProcess.includes(filePath)) {
                    this.data.toProcess.push(filePath);
                    addedToProcess++;
                }
            }
        }

        if (addedToPlaylist > 0 || addedToProcess > 0) {
            console.log(
                `[PlaylistTrackerLazy] Random batch: ${addedToPlaylist} to playlist, ${addedToProcess} to process`
            );

            if (addedToPlaylist > 0 && this.onPlaylistChange) {
                this.onPlaylistChange();
            }
            return true;
        }
        return false;
    }

    // Step 2: Extract metadata for a batch of files
    private async extractMetadataBatch(): Promise<void> {
        if (!this.data.toProcess || this.data.toProcess.length === 0) {
            return;
        }

        // Skip if we have files in flight - wait for them to complete first
        if (this.inFlightMoodAnalysis.size > 0) {
            console.log(
                `[PlaylistTrackerLazy] Skipping metadata extraction - ${this.inFlightMoodAnalysis.size} files in flight`
            );
            return;
        }

        const filesToExtract = this.data.toProcess.slice(
            0,
            this.discoveryTriggerSize - this.pendingMoodAnalysis.size
        );
        console.log(`[PlaylistTrackerLazy] Extracting metadata for ${filesToExtract.length} files`);

        for (const filePath of filesToExtract) {
            // Remove from toProcess queue
            const index = this.data.toProcess.indexOf(filePath);
            if (index !== -1) {
                this.data.toProcess.splice(index, 1);
            }

            // Skip if already pending mood analysis or in flight
            if (this.pendingMoodAnalysis.has(filePath) || this.inFlightMoodAnalysis.has(filePath)) {
                console.log(
                    `[PlaylistTrackerLazy] Skipping already pending file: ${path.basename(filePath)}`
                );
                continue;
            }

            // Check if file still exists
            if (!fs.existsSync(filePath)) {
                console.warn(`[PlaylistTrackerLazy] File no longer exists: ${filePath}`);
                this.processedFiles.add(filePath);
                continue;
            }

            try {
                const result = await this.fileProcessor.extractFileMetadata(
                    filePath,
                    this.musicFolder
                );

                if (result.success && result.metadata) {
                    // Check if file already has real mood code
                    if (result.metadata.moodCode && result.metadata.moodCode !== '55555') {
                        // Already has mood, go directly to analyzed
                        this.analyzedFiles.set(filePath, {
                            filePath,
                            metadata: result.metadata,
                            moodCode: result.metadata.moodCode,
                            bpm: result.metadata.bpm,
                        });
                        console.log(
                            `[PlaylistTrackerLazy] File already has mood code: ${path.basename(filePath)}`
                        );
                    } else {
                        // Needs mood analysis
                        this.pendingMoodAnalysis.set(filePath, result.metadata);
                        console.log(
                            `[PlaylistTrackerLazy] Metadata extracted, pending mood: ${path.basename(filePath)}`
                        );
                    }
                } else {
                    // Failed to extract metadata - quarantine
                    console.error(
                        `[PlaylistTrackerLazy] Failed to extract metadata: ${path.basename(filePath)} - ${result.error}`
                    );
                    if (!result.quarantined) {
                        await quarantineFile(
                            filePath,
                            this.musicFolder,
                            result.error || 'Metadata extraction failed'
                        );
                    }
                    this.processedFiles.add(filePath);
                }

                // Small delay to prevent native module crashes
                await sleep(100);
            } catch (error: any) {
                console.error(
                    `[PlaylistTrackerLazy] Error extracting metadata: ${path.basename(filePath)}`,
                    error
                );
                await quarantineFile(filePath, this.musicFolder, error.message || 'Unknown error');
                this.processedFiles.add(filePath);
            }
        }
    }

    // Step 3: Request mood analysis for pending files
    private async analyzeMoodBatch(): Promise<void> {
        if (this.pendingMoodAnalysis.size === 0) {
            return;
        }

        // Skip if we already have files in flight to renderer
        if (this.inFlightMoodAnalysis.size > 0) {
            console.log(
                `[PlaylistTrackerLazy] Skipping mood batch - ${this.inFlightMoodAnalysis.size} files already in flight`
            );
            return;
        }

        // In mock-api mode, use fallback mood codes
        if (this.isMockApiMode) {
            console.log('[PlaylistTrackerLazy] MOCK-API mode: using fallback mood codes');
            for (const [filePath, metadata] of this.pendingMoodAnalysis) {
                this.analyzedFiles.set(filePath, {
                    filePath,
                    metadata,
                    moodCode: '55555', // Fallback
                    bpm: metadata.bpm || '120',
                });
            }
            this.pendingMoodAnalysis.clear();
            return;
        }

        // Request batch mood analysis from renderer
        if (!this.onRequestMoodBatchAnalysis) {
            console.warn(
                '[PlaylistTrackerLazy] No batch mood analysis handler registered, using fallback'
            );
            for (const [filePath, metadata] of this.pendingMoodAnalysis) {
                this.analyzedFiles.set(filePath, {
                    filePath,
                    metadata,
                    moodCode: '55555',
                    bpm: metadata.bpm || '120',
                });
            }
            this.pendingMoodAnalysis.clear();
            return;
        }

        const filePaths = Array.from(this.pendingMoodAnalysis.keys());
        console.log(`[PlaylistTrackerLazy] Requesting mood analysis for ${filePaths.length} files`);

        // Mark files as in-flight to prevent re-sending while waiting for renderer
        for (const filePath of filePaths) {
            this.inFlightMoodAnalysis.add(filePath);
        }

        try {
            const results = await this.onRequestMoodBatchAnalysis(filePaths);

            for (const [filePath, metadata] of this.pendingMoodAnalysis) {
                const result = results.get(filePath);

                if (result && result.success && result.moodCode) {
                    // Mood analysis successful
                    this.analyzedFiles.set(filePath, {
                        filePath,
                        metadata,
                        moodCode: result.moodCode,
                        bpm: result.bpm?.toString() || metadata.bpm || '120',
                    });
                    console.log(
                        `[PlaylistTrackerLazy] Mood analysis complete: ${path.basename(filePath)} -> ${result.moodCode}`
                    );
                } else if (result && !result.success) {
                    // Mood analysis failed - quarantine
                    console.error(
                        `[PlaylistTrackerLazy] Mood analysis failed: ${path.basename(filePath)} - ${result.error}`
                    );
                    await quarantineFile(
                        filePath,
                        this.musicFolder,
                        result.error || 'Mood analysis failed'
                    );
                    this.processedFiles.add(filePath);
                } else {
                    // No result - use fallback
                    console.warn(
                        `[PlaylistTrackerLazy] No mood result for ${path.basename(filePath)}, using fallback`
                    );
                    this.analyzedFiles.set(filePath, {
                        filePath,
                        metadata,
                        moodCode: '55555',
                        bpm: metadata.bpm || '120',
                    });
                }
            }

            this.pendingMoodAnalysis.clear();
        } catch (error: any) {
            console.error('[PlaylistTrackerLazy] Error in batch mood analysis:', error);
            // On error, use fallback for all pending files
            for (const [filePath, metadata] of this.pendingMoodAnalysis) {
                this.analyzedFiles.set(filePath, {
                    filePath,
                    metadata,
                    moodCode: '55555',
                    bpm: metadata.bpm || '120',
                });
            }
            this.pendingMoodAnalysis.clear();
        } finally {
            // Clear in-flight tracking regardless of success/failure
            this.inFlightMoodAnalysis.clear();
        }
    }

    // Step 4: Organize analyzed files and add to playlist
    private async organizeBatch(): Promise<void> {
        if (this.analyzedFiles.size === 0) {
            return;
        }

        console.log(`[PlaylistTrackerLazy] Organizing ${this.analyzedFiles.size} analyzed files`);
        const organizedPaths: string[] = [];

        for (const [filePath, analyzed] of this.analyzedFiles) {
            // Skip files with fallback mood (A#55555) - don't organize, keep for later
            if (analyzed.moodCode === '55555') {
                console.log(
                    `[PlaylistTrackerLazy] Skipping file with fallback mood: ${path.basename(filePath)}`
                );
                continue;
            }

            // Skip files with Unknown Artist/Album - they need AcoustID retry
            if (
                analyzed.metadata.artist === 'Unknown Artist' ||
                analyzed.metadata.album === 'Unknown Album'
            ) {
                console.log(
                    `[PlaylistTrackerLazy] Skipping file with Unknown metadata: ${path.basename(filePath)}`
                );
                continue;
            }

            try {
                const result = await this.fileProcessor.organizeFileWithMetadata(
                    filePath,
                    this.musicFolder,
                    analyzed.metadata,
                    analyzed.moodCode,
                    analyzed.bpm
                );

                if (result.success && result.organizedPath) {
                    organizedPaths.push(result.organizedPath);
                    this.processedFiles.add(filePath);
                    console.log(
                        `[PlaylistTrackerLazy] Organized: ${path.basename(filePath)} -> ${path.basename(result.organizedPath)}`
                    );
                } else {
                    console.error(
                        `[PlaylistTrackerLazy] Failed to organize: ${path.basename(filePath)} - ${result.error}`
                    );
                    this.processedFiles.add(filePath);
                }

                // Small delay to prevent native module crashes
                await sleep(100);
            } catch (error: any) {
                console.error(
                    `[PlaylistTrackerLazy] Error organizing: ${path.basename(filePath)}`,
                    error
                );
                await quarantineFile(
                    filePath,
                    this.musicFolder,
                    error.message || 'Organization failed'
                );
                this.processedFiles.add(filePath);
            }
        }

        this.analyzedFiles.clear();

        // Clean up empty directories after moving files
        const removedDirs = removeEmptyDirectories(this.musicFolder);
        if (removedDirs > 0) {
            console.log(`[PlaylistTrackerLazy] Cleaned up ${removedDirs} empty directories`);
        }

        // Add organized files to playlist (excluding files with Unknown metadata, filtered by mood mode)
        if (organizedPaths.length > 0) {
            // Filter out files with Unknown Artist/Album - they need AcoustID retry later
            const completeFiles = organizedPaths.filter((p) => !hasUnknownMetadata(p));
            const unknownFiles = organizedPaths.filter((p) => hasUnknownMetadata(p));

            if (unknownFiles.length > 0) {
                console.log(
                    `[PlaylistTrackerLazy] Skipping ${unknownFiles.length} files with Unknown metadata (will retry later)`
                );
            }

            // Filter by mood mode
            const moodFilteredFiles = completeFiles.filter((p) =>
                matchesMoodMode(p, this.moodMode, this.moodModes)
            );
            const remainingSlots = this.maxPlaylistSize - this.data.playlist.length;
            const toAdd = moodFilteredFiles.slice(0, remainingSlots);
            this.data.playlist.push(...toAdd);
            console.log(
                `[PlaylistTrackerLazy] Added ${toAdd.length} files to playlist matching mood "${this.moodMode}" (${this.data.playlist.length}/${this.maxPlaylistSize})`
            );

            // Notify that playlist changed
            if (this.onPlaylistChange) {
                this.onPlaylistChange();
            }
        }
    }
}
