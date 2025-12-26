import {
    app,
    BrowserWindow,
    dialog,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    Tray,
} from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import {audioPlayer} from './services/audioPlayer';
import {ConfigStore} from './services/configStore';
import {PlaylistTrackerLazy} from './services/playlistTrackerLazy';
import {renameFileWithMoodCode} from './utils/fileRenamer';
import {formatMoodCode, type MoodScores} from './services/essentiaService';
import {writeMoodMetadata} from './services/id3MetadataService';

dotenv.config();

// Enhanced crash logging - use app userData path to avoid permission issues
// app.getPath('userData') isn't available before app.on('ready'), so we defer log setup
let LOG_DIR = '';
let LOG_FILE = '';
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB max per log file
const MAX_LOG_FILES = 5; // Keep only last 5 log files
let currentLogSize = 0;

function initializeLogging() {
    LOG_DIR = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, {recursive: true});
    }
    LOG_FILE = path.join(LOG_DIR, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    currentLogSize = 0;

    // Clean up old log files, keep only the most recent ones
    cleanupOldLogs();
}

function cleanupOldLogs() {
    try {
        const files = fs
            .readdirSync(LOG_DIR)
            .filter((f) => f.startsWith('app-') && f.endsWith('.log'))
            .map((f) => ({
                name: f,
                path: path.join(LOG_DIR, f),
                mtime: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime(),
            }))
            .sort((a, b) => b.mtime - a.mtime); // Newest first

        // Remove old files beyond MAX_LOG_FILES
        for (let i = MAX_LOG_FILES; i < files.length; i++) {
            fs.unlinkSync(files[i].path);
            console.log(`[Logging] Removed old log file: ${files[i].name}`);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

function writeToLogFile(message: string) {
    if (!LOG_FILE) {
        return;
    }

    try {
        // Check if we need to rotate
        if (currentLogSize > MAX_LOG_SIZE) {
            // Create new log file
            LOG_FILE = path.join(
                LOG_DIR,
                `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
            );
            currentLogSize = 0;
            cleanupOldLogs();
        }

        fs.appendFileSync(LOG_FILE, message);
        currentLogSize += message.length;
    } catch (e) {
        // Ignore file write errors
    }
}

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;

    // Write to original console
    originalConsoleLog(logMessage.trim());

    // Write to log file with rotation
    writeToLogFile(logMessage);
}

// Store original console methods
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

// Intercept console.log to also write to log file
console.log = (...args: any[]) => {
    const message = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
    originalConsoleLog(...args);
    writeToLogFile(`[${new Date().toISOString()}] [LOG] ${message}\n`);
};

console.error = (...args: any[]) => {
    const message = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
    originalConsoleError(...args);
    writeToLogFile(`[${new Date().toISOString()}] [ERROR] ${message}\n`);
};

console.warn = (...args: any[]) => {
    const message = args
        .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
    originalConsoleWarn(...args);
    writeToLogFile(`[${new Date().toISOString()}] [WARN] ${message}\n`);
};

// Catch unhandled errors
process.on('uncaughtException', (error) => {
    log(`UNCAUGHT EXCEPTION: ${error.message}`, 'ERROR');
    log(`Stack: ${error.stack}`, 'ERROR');
});

process.on('unhandledRejection', (reason, promise) => {
    log(`UNHANDLED REJECTION: ${reason}`, 'ERROR');
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let playlistTrackerLazy: PlaylistTrackerLazy | null = null;

function createWindow() {
    if (mainWindow) {
        mainWindow.show();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 500,
        height: 500,
        minWidth: 400,
        minHeight: 400,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'Ambiance',
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Open DevTools for debugging
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    // Don't destroy window on close, just hide it
    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function syncAudioPlayerPlaylist(songWasConsumed = false) {
    if (!playlistTrackerLazy) {
        return;
    }

    const playlist = playlistTrackerLazy.getPlaylist();
    const mp3Infos = playlist.map((filePath) => ({
        filePath,
        fileName: path.basename(filePath),
        directory: path.dirname(filePath),
    }));

    const currentMP3 = audioPlayer.getCurrentMP3();
    const currentIndex = audioPlayer.getCurrentIndex();

    // Update playlist
    audioPlayer.setPlaylist(mp3Infos);

    // Handle index after sync
    if (songWasConsumed) {
        // Song was consumed (removed), so current index now points to what was the "next" song
        // Keep the same index, but it now points to the next song in line
        const safeIndex = Math.min(currentIndex, mp3Infos.length - 1);
        audioPlayer.setCurrentIndex(Math.max(0, safeIndex));

        console.log(
            `[Ambiance] Song consumed, index adjusted to ${safeIndex} (${mp3Infos.length} songs remaining)`
        );
    } else if (currentMP3 && mp3Infos.length > 0) {
        // Normal sync - try to maintain current position
        const newIndex = mp3Infos.findIndex((mp3) => mp3.filePath === currentMP3.filePath);
        if (newIndex !== -1) {
            // Current song still in playlist
            audioPlayer.setCurrentIndex(newIndex);
        } else {
            // Current song was removed unexpectedly
            const safeIndex = Math.min(currentIndex, mp3Infos.length - 1);
            audioPlayer.setCurrentIndex(Math.max(0, safeIndex));
        }
    } else if (mp3Infos.length > 0) {
        // No current song, start from beginning
        audioPlayer.setCurrentIndex(0);
        console.log(`[Ambiance] Initialized currentMP3 to first song: ${mp3Infos[0]?.fileName}`);
    }

    const stats = playlistTrackerLazy.getStats();
    const currentMP3AfterSync = audioPlayer.getCurrentMP3();
    console.log(
        `[Ambiance] Playlist synced: ${mp3Infos.length} songs, ${stats.toProcessCount} to process, ${stats.processedCount} processed`
    );
    console.log(`[Ambiance] Current MP3 after sync: ${currentMP3AfterSync?.fileName || 'null'}`);

    // Notify renderer to update UI
    if (mainWindow && mp3Infos.length > 0) {
        mainWindow.webContents.send('playlist-updated', {
            count: mp3Infos.length,
            stats: stats,
        });
    }
}

async function initializeChore() {
    log('Initializing MP3...');
    log(`Current working directory: ${process.cwd()}`);
    log(`__dirname: ${__dirname}`);
    log(`AMBIANCE_FOLDER env: ${process.env.AMBIANCE_FOLDER}`);

    // Get musicFolder key with priority: .env → Settings UI → defaults
    let musicFolder = '';
    try {
        if (process.env.AMBIANCE_FOLDER) {
            // Take first folder from env config
            const foldersEnv = process.env.AMBIANCE_FOLDER;
            const rawFolder = foldersEnv.split(',')[0].trim();
            // Resolve relative paths to absolute paths
            musicFolder = path.isAbsolute(rawFolder) ? rawFolder : path.resolve(rawFolder);
            log(`Raw folder from env: ${rawFolder}`);
            log(`Resolved folder: ${musicFolder}`);
            // Save to config for future use
            ConfigStore.setMusicFolder(musicFolder);
        } else {
            musicFolder = ConfigStore.getMusicFolder();
            log(`Using config store folder: ${musicFolder}`);
        }

        if (!musicFolder) {
            log('ERROR: No music folder configured', 'ERROR');
            return;
        }

        log(`Searching in folder: ${musicFolder}`);
    } catch (error: any) {
        log(`ERROR in folder resolution: ${error.message}`, 'ERROR');
        log(`Stack: ${error.stack}`, 'ERROR');
        return;
    }

    // Get AcoustID key with priority: .env → Settings UI → defaults
    let acoustidKey = '';
    try {
        if (process.env.ACOUSTID_KEY) {
            acoustidKey = process.env.ACOUSTID_KEY;
            log('Using ACOUSTID_KEY from .env');
            // Save to config for future use
            ConfigStore.setAcoustidKey(acoustidKey);
        } else {
            acoustidKey = ConfigStore.getAcoustidKey();
            if (acoustidKey) {
                log('Using ACOUSTID_KEY from Settings UI');
            } else {
                log('No ACOUSTID_KEY configured');
            }
        }
    } catch (error: any) {
        log(`ERROR reading ACOUSTID_KEY: ${error.message}`, 'ERROR');
    }

    try {
        // Initialize lazy playlist tracker
        if (playlistTrackerLazy) {
            log('Stopping existing playlist tracker...');
            playlistTrackerLazy.stop();
        }

        log('Creating new PlaylistTrackerLazy...');
        playlistTrackerLazy = new PlaylistTrackerLazy(musicFolder, acoustidKey);
        log('PlaylistTrackerLazy created successfully');

        // Mood mode is now restored automatically from ambiance.json in constructor
        log(`Restored mood mode: ${playlistTrackerLazy.getMoodMode()}`);
    } catch (error: any) {
        log(`CRITICAL ERROR creating PlaylistTrackerLazy: ${error.message}`, 'ERROR');
        log(`Stack: ${error.stack}`, 'ERROR');
        return;
    }

    // Set callback to sync audioPlayer when playlist changes
    playlistTrackerLazy.setOnPlaylistChange((songWasConsumed) => {
        syncAudioPlayerPlaylist(songWasConsumed);
    });

    // Set callback for batch mood analysis requests
    playlistTrackerLazy.setOnRequestMoodBatchAnalysis(async (filePaths: string[]) => {
        console.log(`[Ambiance] Batch mood analysis requested for ${filePaths.length} files`);
        return await requestMoodBatchAnalysis(filePaths);
    });

    await playlistTrackerLazy.start();

    // Initial sync
    syncAudioPlayerPlaylist();

    console.log('[Ambiance] Lazy playlist tracker started');
}

// Show settings (flip card to settings side)
function showSettings() {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.send('show-settings');
    }
}

// Create application menu
function createMenu() {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Ambiance',
            submenu: [
                {
                    label: 'Show Player',
                    click: () => createWindow(),
                },
                {
                    label: 'Settings...',
                    accelerator: 'Cmd+,',
                    click: () => showSettings(),
                },
                {type: 'separator'},
                {role: 'quit'},
            ],
        },
        {
            label: 'Edit',
            submenu: [{role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}],
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// Create tray icon and menu
function createTray() {
    // Try to use tray template icon first, fallback to app icon
    let trayIcon = nativeImage.createEmpty();
    const appIconPath = path.join(__dirname, '../assets/icon.icns');

    try {
        const appIcon = nativeImage.createFromPath(appIconPath);
        if (!appIcon.isEmpty()) {
            trayIcon = appIcon.resize({width: 16, height: 16});
        }
    } catch (e) {
        console.log('[Ambiance] Could not load tray icon, using default');
    }

    tray = new Tray(trayIcon);
    tray.setToolTip('Ambiance - Music Player');

    const mp3Info = audioPlayer.getCurrentMP3();
    const currentSong = mp3Info ? mp3Info.fileName : 'No song loaded';

    const contextMenu = Menu.buildFromTemplate([
        {
            label: currentSong,
            enabled: false,
        },
        {type: 'separator'},
        {
            label: 'Play/Pause',
            accelerator: 'MediaPlayPause',
            click: () => {
                if (mainWindow) {
                    mainWindow.webContents.send('toggle-play');
                }
            },
        },
        {type: 'separator'},
        {
            label: 'Show Player',
            click: () => createWindow(),
        },
        {
            label: 'Settings...',
            click: () => showSettings(),
        },
        {type: 'separator'},
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);

    // Click on tray icon shows/hides window
    tray.on('click', () => {
        if (mainWindow?.isVisible()) {
            mainWindow.hide();
        } else {
            createWindow();
        }
    });
}

app.whenReady().then(async () => {
    // Initialize logging now that app is ready
    initializeLogging();
    log('=== Ambiance Starting ===');
    log(`Node version: ${process.version}`);
    log(`Electron version: ${process.versions.electron}`);
    log(`Platform: ${process.platform} ${process.arch}`);
    log(`Working directory: ${process.cwd()}`);
    log(`Log directory: ${LOG_DIR}`);

    const isMockAllMode = process.env.MODE === 'mock-all';
    const isMockApiMode = process.env.MODE === 'mock-api';
    const isMockUserMode = process.env.MODE === 'mock-user';

    if (!isMockAllMode && !isMockApiMode && !isMockUserMode) {
        createMenu();
        createTray();
        createWindow();
        await initializeChore();

        // Register media keys after a short delay to ensure app is fully ready
        // This prevents "globalShortcut cannot be used before the app is ready" errors
        setImmediate(() => {
            try {
                log('Registering global shortcuts...');

                const playPauseRegistered = globalShortcut.register('MediaPlayPause', () => {
                    log('MediaPlayPause triggered');
                    if (mainWindow) {
                        mainWindow.webContents.send('toggle-play');
                    }
                });

                const nextTrackRegistered = globalShortcut.register('MediaNextTrack', () => {
                    log('MediaNextTrack triggered');
                    if (mainWindow) {
                        mainWindow.webContents.send('next-song');
                    }
                });

                if (playPauseRegistered && nextTrackRegistered) {
                    log('Media keys registered successfully');
                } else {
                    log('Some media keys failed to register (may still work)', 'WARN');
                }
            } catch (error: any) {
                log(`Error registering global shortcuts: ${error.message}`, 'ERROR');
            }
        });
    } else {
        console.log('[Ambiance] Running in MOCK mode - no GUI, processing files only');
        await initializeChore();
    }
});

app.on('activate', () => {
    createWindow();
});

app.on('window-all-closed', () => {
    // Don't quit the app when all windows are closed on macOS
    // The app stays in the menu bar
    // Do nothing - keep running in tray
});

app.on('before-quit', () => {
    // Set flag so windows can close properly
    isQuitting = true;
});

app.on('will-quit', () => {
    // Unregister all shortcuts
    globalShortcut.unregisterAll();

    // Stop playlist trackers
    if (playlistTrackerLazy) {
        playlistTrackerLazy.stop();
    }
});

// IPC handlers
ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('get-mp3-info', () => {
    return audioPlayer.getCurrentMP3();
});

ipcMain.handle('get-playing-state', () => {
    return audioPlayer.getIsPlaying();
});

ipcMain.handle('set-playing-state', (_event, isPlaying: boolean) => {
    audioPlayer.setIsPlaying(isPlaying);
    return isPlaying;
});

ipcMain.handle('next-song', () => {
    if (playlistTrackerLazy) {
        // For lazy tracker: consume current song, then get current (which is now the "next")
        const currentMP3 = audioPlayer.getCurrentMP3();
        if (currentMP3) {
            playlistTrackerLazy.consumeSong(currentMP3.filePath);
            // After consumption and sync, the current index now points to what was the "next" song
            const nextMP3 = audioPlayer.getCurrentMP3();
            console.log('[Ambiance] Next song (after consumption):', nextMP3?.fileName);
            return nextMP3;
        }
    }

    return null;
});

ipcMain.handle('get-music-folder', () => {
    return ConfigStore.getMusicFolder();
});

ipcMain.handle('set-music-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Music Folder',
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const folder = result.filePaths[0];
        ConfigStore.setMusicFolder(folder);
        return ConfigStore.getMusicFolder();
    }

    return ConfigStore.getMusicFolder();
});

ipcMain.handle('reload-mp3', () => {
    initializeChore();
    if (mainWindow) {
        mainWindow.webContents.send('mp3-reloaded');
    }
});

ipcMain.handle('get-acoustid-key', () => {
    return ConfigStore.getAcoustidKey();
});

ipcMain.handle('set-acoustid-key', (_event, key: string) => {
    ConfigStore.setAcoustidKey(key);
    return key;
});

ipcMain.handle('open-settings', () => {
    showSettings();
});

ipcMain.handle('track-listen', (_event, filePath: string) => {
    if (playlistTrackerLazy) {
        playlistTrackerLazy.trackListen(filePath);
    }
});

ipcMain.handle('get-playlist', () => {
    return playlistTrackerLazy?.getPlaylist() ?? [];
});

ipcMain.handle('get-history', () => {
    return playlistTrackerLazy?.getHistory() ?? [];
});

ipcMain.handle('get-stats', () => {
    return (
        playlistTrackerLazy?.getStats() ?? {
            playlistSize: playlistTrackerLazy?.getPlaylist().length || 0,
            toProcessCount: 0,
            processedCount: 0,
            totalListens: playlistTrackerLazy?.getHistory().length || 0,
        }
    );
});

ipcMain.handle('set-mood-mode', (_event, mode: 'all' | 'calm' | 'neutral' | 'excited') => {
    console.log('[Ambiance] Setting mood mode to:', mode);
    if (playlistTrackerLazy) {
        playlistTrackerLazy.setMoodMode(mode);
    }
});

ipcMain.handle('get-mood-mode', () => {
    return playlistTrackerLazy?.getMoodMode() || 'all';
});

ipcMain.handle('get-mood-modes', () => {
    return playlistTrackerLazy?.getMoodModes() || [];
});

ipcMain.handle('set-mood-modes', (_event, modes) => {
    if (playlistTrackerLazy) {
        playlistTrackerLazy.setMoodModes(modes);
    }
});

ipcMain.handle(
    'rename-file-with-mood',
    async (_event, filePath: string, moodScores: MoodScores, bpm?: number) => {
        try {
            console.log('[Ambiance] Renaming file with mood scores and BPM:', filePath, bpm);
            const moodCode = formatMoodCode(moodScores);
            const result = await renameFileWithMoodCode(filePath, moodCode, bpm);

            if (result.success) {
                console.log('[Ambiance] File renamed successfully:', result.newPath);

                // Write mood and BPM to ID3 metadata
                if (result.newPath && bpm) {
                    await writeMoodMetadata(result.newPath, moodCode, bpm);
                }

                // Update toProcess array to replace old path with new path
                if (playlistTrackerLazy && result.oldPath && result.newPath) {
                    playlistTrackerLazy.updateFilePathInToProcess(result.oldPath, result.newPath);
                }

                // Reload the playlist to reflect the renamed file
                initializeChore();
            } else {
                console.error('[Ambiance] File rename failed:', result.error);
            }

            return result;
        } catch (error: any) {
            console.error('[Ambiance] Error in rename-file-with-mood:', error);
            return {
                success: false,
                oldPath: filePath,
                error: error.message || 'Unknown error',
            };
        }
    }
);

// Batch mood analysis state
interface MoodBatchResult {
    filePath: string;
    success: boolean;
    moodCode?: string;
    bpm?: number;
    error?: string;
}

interface PendingBatch {
    results: Map<string, MoodBatchResult>;
    expectedCount: number;
    resolve: (results: Map<string, MoodBatchResult>) => void;
    timeoutId: NodeJS.Timeout;
}

const pendingBatches = new Map<string, PendingBatch>();

// Request batch mood analysis from renderer
export function requestMoodBatchAnalysis(
    filePaths: string[],
    timeoutMs = 60000
): Promise<Map<string, MoodBatchResult>> {
    return new Promise((resolve) => {
        if (!mainWindow || filePaths.length === 0) {
            resolve(new Map());
            return;
        }

        const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        console.log(
            `[Ambiance] Requesting batch mood analysis: ${batchId} (${filePaths.length} files)`
        );

        const timeoutId = setTimeout(() => {
            const batch = pendingBatches.get(batchId);
            if (batch) {
                console.log(`[Ambiance] Batch ${batchId} timed out, returning partial results`);
                pendingBatches.delete(batchId);
                resolve(batch.results);
            }
        }, timeoutMs);

        pendingBatches.set(batchId, {
            results: new Map(),
            expectedCount: filePaths.length,
            resolve,
            timeoutId,
        });

        mainWindow.webContents.send('analyze-mood-batch-request', filePaths, batchId);
    });
}

// Handle individual mood result from batch
ipcMain.handle(
    'mood-batch-result',
    async (
        _event,
        batchId: string,
        filePath: string,
        success: boolean,
        moodCode?: string,
        bpm?: number,
        error?: string
    ) => {
        const batch = pendingBatches.get(batchId);
        if (!batch) {
            console.warn(`[Ambiance] Received result for unknown batch: ${batchId}`);
            return;
        }

        batch.results.set(filePath, {
            filePath,
            success,
            moodCode,
            bpm,
            error,
        });

        console.log(
            `[Ambiance] Batch ${batchId}: ${batch.results.size}/${batch.expectedCount} complete`
        );
    }
);

// Handle batch completion signal
ipcMain.handle('mood-batch-complete', async (_event, batchId: string) => {
    const batch = pendingBatches.get(batchId);
    if (!batch) {
        console.warn(`[Ambiance] Received completion for unknown batch: ${batchId}`);
        return;
    }

    clearTimeout(batch.timeoutId);
    pendingBatches.delete(batchId);
    console.log(`[Ambiance] Batch ${batchId} complete with ${batch.results.size} results`);
    batch.resolve(batch.results);
});
