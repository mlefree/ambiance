export {};

interface MP3Info {
    filePath: string;
    fileName: string;
    directory: string;
}

interface ListenedTrack {
    filePath: string;
    listenedAt: string;
}

interface MoodScores {
    danceability: number;
    happy: number;
    sad: number;
    aggressive: number;
    relaxed: number;
}

interface RenameResult {
    success: boolean;
    oldPath: string;
    newPath?: string;
    error?: string;
}

interface MoodParameterRule {
    min?: number;
    max?: number;
}

interface MoodModeDefinition {
    name: string;
    rules: {
        danceability?: MoodParameterRule;
        happy?: MoodParameterRule;
        sad?: MoodParameterRule;
        aggressive?: MoodParameterRule;
        relaxed?: MoodParameterRule;
    };
    logic: 'AND' | 'OR';
    isDefault?: boolean;
}

declare class WorkerManager {
    initialize(): Promise<boolean>;
    analyzeFile(filePath: string): Promise<{scores: MoodScores; bpm: number} | null>;
    terminate(): void;
}

declare global {
    interface Window {
        electronAPI: {
            getAppVersion: () => Promise<string>;
            getMP3Info: () => Promise<MP3Info | null>;
            getPlayingState: () => Promise<boolean>;
            setPlayingState: (isPlaying: boolean) => Promise<boolean>;
            nextSong: () => Promise<MP3Info | null>;
            onTogglePlay: (callback: () => void) => void;
            onNextSong: (callback: () => void) => void;
            onMP3Reloaded: (callback: () => void) => void;
            onPlaylistUpdated: (callback: () => void) => void;
            getMusicFolder: () => Promise<string>;
            setMusicFolder: () => Promise<string>;
            reloadMP3: () => Promise<void>;
            getAcoustidKey: () => Promise<string>;
            setAcoustidKey: (key: string) => Promise<string>;
            openSettings: () => Promise<void>;
            onShowSettings: (callback: () => void) => void;
            trackListen: (filePath: string) => Promise<void>;
            getPlaylist: () => Promise<string[]>;
            getHistory: () => Promise<ListenedTrack[]>;
            renameFileWithMood: (
                filePath: string,
                moodScores: MoodScores,
                bpm?: number
            ) => Promise<RenameResult>;
            analyzeMoodForFile: (filePath: string) => Promise<any>;
            onAnalyzeMoodRequest: (callback: (filePath: string) => void) => void;
            // Batch mood analysis APIs
            onAnalyzeMoodBatchRequest: (
                callback: (filePaths: string[], batchId: string) => void
            ) => void;
            sendMoodBatchResult: (
                batchId: string,
                filePath: string,
                success: boolean,
                moodCode?: string,
                bpm?: number,
                error?: string
            ) => Promise<void>;
            sendMoodBatchComplete: (batchId: string) => Promise<void>;
            // Mood mode filter
            setMoodMode: (mode: string) => Promise<void>;
            getMoodMode: () => Promise<string>;
            // Mood modes definitions
            getMoodModes: () => Promise<MoodModeDefinition[]>;
            setMoodModes: (modes: MoodModeDefinition[]) => Promise<void>;
        };
    }
}
