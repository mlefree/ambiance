import {contextBridge, ipcRenderer} from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getMP3Info: () => ipcRenderer.invoke('get-mp3-info'),
    setPlayingState: (isPlaying: boolean) => ipcRenderer.invoke('set-playing-state', isPlaying),
    nextSong: () => ipcRenderer.invoke('next-song'),
    onTogglePlay: (callback: () => void) => {
        ipcRenderer.on('toggle-play', callback);
    },
    onNextSong: (callback: () => void) => {
        ipcRenderer.on('next-song', callback);
    },
    onMP3Reloaded: (callback: () => void) => {
        ipcRenderer.on('mp3-reloaded', callback);
    },
    onPlaylistUpdated: (callback: () => void) => {
        ipcRenderer.on('playlist-updated', callback);
    },
    // Settings APIs
    getMusicFolder: () => ipcRenderer.invoke('get-music-folder'),
    setMusicFolder: () => ipcRenderer.invoke('set-music-folder'),
    reloadMP3: () => ipcRenderer.invoke('reload-mp3'),
    getAcoustidKey: () => ipcRenderer.invoke('get-acoustid-key'),
    setAcoustidKey: (key: string) => ipcRenderer.invoke('set-acoustid-key', key),
    openSettings: () => ipcRenderer.invoke('open-settings'),
    onShowSettings: (callback: () => void) => {
        ipcRenderer.on('show-settings', callback);
    },
    // Playlist tracking APIs
    trackListen: (filePath: string) => ipcRenderer.invoke('track-listen', filePath),
    getPlaylist: () => ipcRenderer.invoke('get-playlist'),
    getHistory: () => ipcRenderer.invoke('get-history'),
    // Mood analysis APIs
    renameFileWithMood: (filePath: string, moodScores: any, bpm?: number) =>
        ipcRenderer.invoke('rename-file-with-mood', filePath, moodScores, bpm),
    onAnalyzeMoodRequest: (callback: (filePath: string) => void) => {
        ipcRenderer.on('analyze-mood-request', (_event, filePath) => callback(filePath));
    },
    // Batch mood analysis APIs
    onAnalyzeMoodBatchRequest: (callback: (filePaths: string[], batchId: string) => void) => {
        ipcRenderer.on('analyze-mood-batch-request', (_event, filePaths, batchId) =>
            callback(filePaths, batchId)
        );
    },
    sendMoodBatchResult: (
        batchId: string,
        filePath: string,
        success: boolean,
        moodCode?: string,
        bpm?: number,
        error?: string
    ) => ipcRenderer.invoke('mood-batch-result', batchId, filePath, success, moodCode, bpm, error),
    sendMoodBatchComplete: (batchId: string) => ipcRenderer.invoke('mood-batch-complete', batchId),
    // Mood mode filter
    setMoodMode: (mode: string) => ipcRenderer.invoke('set-mood-mode', mode),
    getMoodMode: () => ipcRenderer.invoke('get-mood-mode'),
    // Mood modes definitions
    getMoodModes: () => ipcRenderer.invoke('get-mood-modes'),
    setMoodModes: (modes: unknown[]) => ipcRenderer.invoke('set-mood-modes', modes),
});
