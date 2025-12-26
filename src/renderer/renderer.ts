// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./renderer.d.ts" />

// Re-declare types locally (from renderer.d.ts) for use in this file
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

console.log('[Renderer] Script loaded - mood analysis with web worker enabled');

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// MoodScores interface (5 dimensions)
interface MoodScores {
    danceability: number;
    happy: number;
    sad: number;
    aggressive: number;
    relaxed: number;
}

// Worker manager type definitions
interface WorkerRequest {
    type: 'initialize' | 'analyze';
    id?: string;
    filePath?: string;
    audioData?: Float32Array;
    sampleRate?: number;
}

interface AnalyzeResponse {
    type: 'analyze-result';
    id: string;
    success: boolean;
    scores?: MoodScores;
    bpm?: number;
    error?: string;
}

interface InitializeResponse {
    type: 'initialize-result';
    success: boolean;
    error?: string;
}

type WorkerResponse = AnalyzeResponse | InitializeResponse;

interface AnalysisResult {
    scores: MoodScores;
    bpm: number;
}

interface PendingRequest {
    resolve: (result: AnalysisResult | null) => void;
    reject: (error: Error) => void;
}

// WorkerManager class for handling communication with moodsWorker
class WorkerManager {
    private worker: Worker | null = null;
    private isInitialized = false;
    private pendingRequests = new Map<string, PendingRequest>();
    private requestCounter = 0;

    constructor() {
        this.initWorker();
    }

    async initialize(): Promise<boolean> {
        if (!this.worker) {
            console.error('[WorkerManager] Worker not created');
            return false;
        }
        this.worker.postMessage({type: 'initialize'});

        for (let i = 0; !this.isInitialized && i <= 30; i++) {
            await sleep(1000);
        }
        return this.isInitialized;
    }

    async analyzeFile(filePath: string): Promise<AnalysisResult | null> {
        if (!this.worker) {
            console.error('[WorkerManager] Worker not available');
            return null;
        }

        if (!this.isInitialized) {
            console.error('[WorkerManager] Worker not initialized');
            return null;
        }

        // Decode audio in main thread (AudioContext not available in workers)
        let audioData: Float32Array;
        let sampleRate: number;
        try {
            const result = await this.decodeAudioFile(filePath);
            audioData = result.audioData;
            sampleRate = result.sampleRate;
        } catch (error) {
            console.error('[WorkerManager] Failed to decode audio:', error);
            return null;
        }

        return new Promise((resolve, reject) => {
            const id = `analyze-${++this.requestCounter}`;

            this.pendingRequests.set(id, {resolve, reject});

            const message: WorkerRequest = {
                type: 'analyze',
                id,
                filePath,
                audioData,
                sampleRate,
            };

            if (this.worker) {
                // Transfer the audioData buffer for efficiency
                this.worker.postMessage(message, [audioData.buffer]);
            }

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Analysis timeout'));
                }
            }, 60000);
        });
    }

    // Decode audio file in main thread where AudioContext is available
    // Sends full audio to worker for multi-segment analysis
    private async decodeAudioFile(
        filePath: string
    ): Promise<{audioData: Float32Array; sampleRate: number}> {
        // Convert file path to proper file:// URL with correct encoding
        const fileUrl = `file://${encodeURI(filePath).replace(/#/g, '%23')}`;

        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();

        const audioContext = new AudioContext();
        try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const fullAudioData = audioBuffer.getChannelData(0);
            const sampleRate = audioBuffer.sampleRate;

            // Send the full audio to the worker for multi-segment analysis
            // The worker will extract beginning, middle, and end segments
            const audioData = fullAudioData;
            console.log(
                `[WorkerManager] Sending full audio: ${fullAudioData.length / sampleRate}s`
            );

            // Return a copy since we're closing the context
            return {
                audioData: new Float32Array(audioData),
                sampleRate,
            };
        } finally {
            await audioContext.close();
        }
    }

    terminate(): void {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.isInitialized = false;
            console.log('[WorkerManager] Worker terminated');
        }
    }

    private initWorker(): void {
        try {
            this.worker = new Worker('./moodsWorker.mjs', {type: 'module'});

            this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                this.handleWorkerMessage(event.data);
            };

            this.worker.onerror = (event) => {
                console.error('[WorkerManager] Worker error:', {
                    message: event.message,
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
                    type: event.type,
                    target: event.target,
                    // Log the full event object for debugging
                    event: event,
                });
            };

            console.log('[WorkerManager] Worker created');
        } catch (error) {
            console.error('[WorkerManager] Failed to create worker:', error);
        }
    }

    private handleWorkerMessage(message: WorkerResponse): void {
        if (message.type === 'initialize-result') {
            this.handleInitializeResponse(message);
        } else if (message.type === 'analyze-result') {
            this.handleAnalyzeResponse(message);
        }
    }

    private handleInitializeResponse(response: InitializeResponse): void {
        if (response.success) {
            this.isInitialized = true;
            console.log('[WorkerManager] Worker initialized successfully');
        } else {
            console.error('[WorkerManager] Worker initialization failed:', response.error);
        }
    }

    private handleAnalyzeResponse(response: AnalyzeResponse): void {
        const pending = this.pendingRequests.get(response.id);

        if (!pending) {
            console.warn('[WorkerManager] No pending request for id:', response.id);
            return;
        }

        this.pendingRequests.delete(response.id);

        if (response.success && response.scores && response.bpm !== undefined) {
            pending.resolve({
                scores: response.scores,
                bpm: response.bpm,
            });
        } else {
            pending.resolve(null);
        }
    }
}

// Create WorkerManager instance for mood analysis
const workerManager = new WorkerManager();

let audio: HTMLAudioElement | null = null;
let isPlaying = false;
let moodAnalyzerInitialized = false;

const playButton = document.getElementById('playButton') as HTMLButtonElement;
const playIcon = document.getElementById('playIcon') as HTMLDivElement;
const nextButton = document.getElementById('nextButton') as HTMLButtonElement;
const mp3InfoDiv = document.getElementById('mp3Info') as HTMLDivElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const settingsButton = document.getElementById('settingsButton') as HTMLButtonElement;
const moodModeSelect = document.getElementById('moodModeSelect') as HTMLSelectElement;
const progressBar = document.getElementById('progressBar') as HTMLInputElement;
const currentTimeSpan = document.getElementById('currentTime') as HTMLSpanElement;
const totalTimeSpan = document.getElementById('totalTime') as HTMLSpanElement;
const waveCanvas = document.getElementById('waveCanvas') as HTMLCanvasElement;
const progressThumbLabel = document.getElementById('progressThumbLabel') as HTMLSpanElement;

// Card flip elements
const card = document.getElementById('card') as HTMLDivElement;
const backButton = document.getElementById('backButton') as HTMLButtonElement;

// Settings elements
const folderDisplay = document.getElementById('folderDisplay') as HTMLDivElement;
const changeFolderBtn = document.getElementById('changeFolderBtn') as HTMLButtonElement;
const reloadBtn = document.getElementById('reloadBtn') as HTMLButtonElement;
const acoustidKeyInput = document.getElementById('acoustidKeyInput') as HTMLInputElement;
const saveAcoustidBtn = document.getElementById('saveAcoustidBtn') as HTMLButtonElement;

// Mood modes editor elements
const moodModesList = document.getElementById('moodModesList') as HTMLDivElement;
const addMoodModeBtn = document.getElementById('addMoodModeBtn') as HTMLButtonElement;
const moodModeModal = document.getElementById('moodModeModal') as HTMLDivElement;
const modalTitle = document.getElementById('modalTitle') as HTMLHeadingElement;
const modalModeName = document.getElementById('modalModeName') as HTMLInputElement;
const modalLogic = document.getElementById('modalLogic') as HTMLSelectElement;
const modalIsDefault = document.getElementById('modalIsDefault') as HTMLInputElement;
const modalCancel = document.getElementById('modalCancel') as HTMLButtonElement;
const modalSave = document.getElementById('modalSave') as HTMLButtonElement;

// Rule inputs
const ruleDanceMin = document.getElementById('ruleDanceMin') as HTMLInputElement;
const ruleDanceMax = document.getElementById('ruleDanceMax') as HTMLInputElement;
const ruleHappyMin = document.getElementById('ruleHappyMin') as HTMLInputElement;
const ruleHappyMax = document.getElementById('ruleHappyMax') as HTMLInputElement;
const ruleSadMin = document.getElementById('ruleSadMin') as HTMLInputElement;
const ruleSadMax = document.getElementById('ruleSadMax') as HTMLInputElement;
const ruleAggressiveMin = document.getElementById('ruleAggressiveMin') as HTMLInputElement;
const ruleAggressiveMax = document.getElementById('ruleAggressiveMax') as HTMLInputElement;
const ruleRelaxedMin = document.getElementById('ruleRelaxedMin') as HTMLInputElement;
const ruleRelaxedMax = document.getElementById('ruleRelaxedMax') as HTMLInputElement;

// Mood modes state
let currentMoodModes: MoodModeDefinition[] = [];
let editingModeIndex: number | null = null;

let isSeeking = false;

// Audio visualization
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let audioSource: MediaElementAudioSourceNode | null = null;
let animationFrameId: number | null = null;
let currentAmplitude = 0;

// Initialize wave canvas
function initWaveCanvas() {
    const rect = waveCanvas.parentElement?.getBoundingClientRect();
    if (rect) {
        waveCanvas.width = rect.width;
        waveCanvas.height = 50;
    }
}

// Setup audio analyzer for visualization
function setupAudioAnalyzer() {
    if (!audio || audioSource) {
        return;
    }

    try {
        if (!audioContext) {
            audioContext = new AudioContext();
        }

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;

        audioSource = audioContext.createMediaElementSource(audio);
        audioSource.connect(analyser);
        analyser.connect(audioContext.destination);

        console.log('[Renderer] Audio analyzer setup complete');
    } catch (error) {
        console.error('[Renderer] Failed to setup audio analyzer:', error);
    }
}

// Get current audio amplitude (0-1)
function getAmplitude(): number {
    if (!analyser) {
        return 0;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }
    const average = sum / dataArray.length;
    return average / 255;
}

// Draw wave animation
function drawWave() {
    const ctx = waveCanvas.getContext('2d');
    if (!ctx) {
        return;
    }

    const width = waveCanvas.width;
    const height = waveCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Get current amplitude and smooth it
    const targetAmplitude = isPlaying ? getAmplitude() : 0;
    currentAmplitude += (targetAmplitude - currentAmplitude) * 0.15;

    // Base amplitude when not playing, dynamic when playing
    const minAmplitude = 3;
    const maxAmplitude = height / 2 - 5;
    const amplitude = minAmplitude + currentAmplitude * (maxAmplitude - minAmplitude);

    // Draw sine wave
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;

    const frequency = 2;
    const phase = Date.now() / 500;

    for (let x = 0; x <= width; x++) {
        const normalizedX = x / width;
        // Amplify in center using Gaussian bell curve
        const centerFactor = 0.3 + 0.7 * Math.exp(-Math.pow((normalizedX - 0.5) * 2.5, 2));
        const localAmplitude = amplitude * centerFactor;
        const y =
            height / 2 + Math.sin(normalizedX * Math.PI * 2 * frequency + phase) * localAmplitude;

        if (x === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.stroke();

    // Draw a second wave for depth
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1.5;

    for (let x = 0; x <= width; x++) {
        const normalizedX = x / width;
        // Amplify in center using Gaussian bell curve
        const centerFactor = 0.3 + 0.7 * Math.exp(-Math.pow((normalizedX - 0.5) * 2.5, 2));
        const localAmplitude = amplitude * 0.6 * centerFactor;
        const y =
            height / 2 +
            Math.sin(normalizedX * Math.PI * 2 * frequency * 1.5 + phase * 1.3) * localAmplitude;

        if (x === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.stroke();

    animationFrameId = requestAnimationFrame(drawWave);
}

// Update thumb label position
function updateThumbPosition() {
    const percent = parseFloat(progressBar.value);
    const progressWidth = progressBar.offsetWidth;
    const thumbWidth = 20;
    const position = (percent / 100) * (progressWidth - thumbWidth) + thumbWidth / 2;
    progressThumbLabel.style.left = `${position}px`;
}

// Start wave animation
function startWaveAnimation() {
    initWaveCanvas();
    if (!animationFrameId) {
        drawWave();
    }
}

// Stop wave animation
function stopWaveAnimation() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

// Initialize wave animation on load
initWaveCanvas();
startWaveAnimation();
window.addEventListener('resize', initWaveCanvas);

// Format seconds to mm:ss
function formatTime(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds)) {
        return '0:00';
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Update progress bar and time display
function updateProgress() {
    if (!audio || isSeeking) {
        return;
    }

    const current = audio.currentTime;
    const duration = audio.duration;

    if (!isNaN(duration) && duration > 0) {
        const percent = (current / duration) * 100;
        progressBar.value = percent.toString();
        currentTimeSpan.textContent = formatTime(current);
        totalTimeSpan.textContent = formatTime(duration);
        updateThumbPosition();
    }
}

// Seek handling
progressBar.addEventListener('mousedown', () => {
    isSeeking = true;
});

progressBar.addEventListener('mouseup', () => {
    isSeeking = false;
});

progressBar.addEventListener('input', () => {
    if (audio && audio.duration) {
        const seekTime = (parseFloat(progressBar.value) / 100) * audio.duration;
        audio.currentTime = seekTime;
        currentTimeSpan.textContent = formatTime(seekTime);
        updateThumbPosition();
    }
});

// Truncate directory to last 2 parts (artist/album)
function truncateDirectory(directory: string): string {
    const parts = directory.split('/').filter((p) => p.length > 0);
    if (parts.length <= 2) {
        return parts.join('/');
    }
    return parts.slice(-2).join('/');
}

// Parse filename to extract metadata
// Format: <artist>-<album>-#<track>-<title>-A#<moods>-B#<bpm>.mp3
function parseFilenameMetadata(fileName: string): {
    title: string;
    artist: string;
    album: string;
    track: string;
} | null {
    const match = fileName.match(/^(.+?)-(.+?)-#(\d+)-(.+?)-A#\d{5}-B#\d+\.mp3$/);
    if (match) {
        return {
            artist: match[1],
            album: match[2],
            track: match[3],
            title: match[4],
        };
    }
    return null;
}

// Truncate filename to remove artist-album prefix
// Format: <artist>-<album>-#<track>-<title>-A#<moods>-B#<bpm>.mp3
// Returns: #<track>-<title>-A#<moods>-B#<bpm>.mp3
function truncateFilename(fileName: string): string {
    const match = fileName.match(/(#\d+-.+)$/);
    if (match) {
        return match[1];
    }
    return fileName;
}

// Render MP3 info with 3 lines: title, artist/album, filename
function renderMP3Info(fileName: string, directory: string): string {
    const meta = parseFilenameMetadata(fileName);
    if (meta) {
        return `
            <div class="song-title">${meta.title}</div>
            <div class="song-artist">${meta.artist} / ${meta.album}</div>
            <div class="song-filename">${fileName}</div>
        `;
    }
    // Fallback for non-standard filenames
    return `
        <div class="file-name">${truncateFilename(fileName)}</div>
        <div class="directory">${truncateDirectory(directory)}</div>
    `;
}

// Reset progress bar when loading new track
function resetProgress() {
    progressBar.value = '0';
    currentTimeSpan.textContent = '0:00';
    totalTimeSpan.textContent = '0:00';
    updateThumbPosition();
}

// Setup progress listeners on audio element
function setupAudioProgressListeners() {
    if (!audio) {
        return;
    }

    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', () => {
        if (audio) {
            totalTimeSpan.textContent = formatTime(audio.duration);
        }
    });
}

// Mood mode change handler - notify main process
moodModeSelect.addEventListener('change', () => {
    const moodMode = moodModeSelect.value as 'all' | 'calm' | 'neutral' | 'excited';
    console.log('[Renderer] Mood mode changed to:', moodMode);
    window.electronAPI.setMoodMode(moodMode);
});

// Setup media session handlers for macOS integration
function setupMediaSession(mp3Info: any) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: mp3Info.fileName,
            artist: 'Ambiance',
            album: mp3Info.directory,
        });

        navigator.mediaSession.setActionHandler('play', () => {
            console.log('[Renderer] MediaSession play');
            playAudio();
        });

        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('[Renderer] MediaSession pause');
            stopAudio();
        });

        navigator.mediaSession.setActionHandler('nexttrack', () => {
            console.log('[Renderer] MediaSession nexttrack');
            nextSong();
        });

        console.log('[Renderer] Media session handlers registered');
    }
}

async function loadMP3Info() {
    console.log('[Renderer] Loading MP3 info...');
    const mp3Info = await window.electronAPI.getMP3Info();
    console.log('[Renderer] MP3 info received:', mp3Info);

    if (mp3Info) {
        mp3InfoDiv.innerHTML = renderMP3Info(mp3Info.fileName, mp3Info.directory);

        // Create audio element with proper file URL encoding
        // Convert file path to proper file:// URL with encoding
        // Use pathname to properly encode the file path
        const fileUrl = `file://${encodeURI(mp3Info.filePath).replace(/#/g, '%23')}`;
        console.log('[Renderer] Creating audio element with URL:', fileUrl);
        audio = new Audio(fileUrl);

        audio.addEventListener('loadeddata', () => {
            console.log('[Renderer] Audio loaded successfully');
        });

        audio.addEventListener('ended', () => {
            console.log('[Renderer] Audio playback ended, advancing to next song');
            nextSong();
        });

        audio.addEventListener('error', (e) => {
            console.error('[Renderer] Audio error:', e);
            console.error('[Renderer] Audio error details:', audio?.error);
            statusDiv.textContent = 'Error loading audio';
        });

        // Setup progress bar listeners
        setupAudioProgressListeners();

        // Setup media session for macOS integration
        setupMediaSession(mp3Info);

        statusDiv.textContent = 'Ready to play';
        playButton.disabled = false;
    } else {
        console.error('[Renderer] No MP3 info received');
        mp3InfoDiv.innerHTML = '<div class="no-file">No MP3 file found</div>';
        statusDiv.textContent = 'No file available';
        playButton.disabled = true;
    }
}

async function playAudio() {
    if (audio) {
        console.log('[Renderer] Attempting to play audio...');

        // Setup audio analyzer for visualization (only once per audio element)
        setupAudioAnalyzer();

        // Resume audio context if suspended (required for Chrome autoplay policy)
        if (audioContext && audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        audio
            .play()
            .then(async () => {
                console.log('[Renderer] Audio playback started successfully');
                isPlaying = true;
                window.electronAPI.setPlayingState(true);
                updatePlayButton();
                statusDiv.textContent = 'Playing';

                // Track this listen
                const mp3Info = await window.electronAPI.getMP3Info();
                if (mp3Info) {
                    window.electronAPI.trackListen(mp3Info.filePath);
                    console.log('[Renderer] Tracked listen for:', mp3Info.fileName);
                }
            })
            .catch((error) => {
                console.error('[Renderer] Error playing audio:', error);
                statusDiv.textContent = 'Error playing audio';
            });
    } else {
        console.error('[Renderer] No audio element available');
    }
}

function stopAudio() {
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
    }
    isPlaying = false;
    window.electronAPI.setPlayingState(false);
    updatePlayButton();
    statusDiv.textContent = 'Stopped';
}

function togglePlay() {
    console.log(
        '[Renderer] togglePlay called, isPlaying:',
        isPlaying,
        'audio:',
        audio ? 'exists' : 'null'
    );
    if (isPlaying) {
        stopAudio();
    } else {
        playAudio();
    }
}

function updatePlayButton() {
    if (isPlaying) {
        playIcon.className = 'stop-icon';
    } else {
        playIcon.className = 'play-icon';
    }
}

async function nextSong() {
    console.log('[Renderer] Loading next song...');
    const nextMP3 = await window.electronAPI.nextSong();

    if (nextMP3) {
        // Stop current audio
        if (audio) {
            audio.pause();
            audio = null;
        }

        // Reset audio source so analyzer will reconnect to new audio
        audioSource = null;

        // Reset progress bar
        resetProgress();

        // Update UI with new song
        mp3InfoDiv.innerHTML = renderMP3Info(nextMP3.fileName, nextMP3.directory);

        // Create new audio element
        const fileUrl = `file://${encodeURI(nextMP3.filePath).replace(/#/g, '%23')}`;
        console.log('[Renderer] Loading next track URL:', fileUrl);
        audio = new Audio(fileUrl);

        audio.addEventListener('loadeddata', () => {
            console.log('[Renderer] Next track loaded successfully');
        });

        audio.addEventListener('ended', () => {
            console.log('[Renderer] Audio playback ended, advancing to next song');
            nextSong();
        });

        audio.addEventListener('error', (e) => {
            console.error('[Renderer] Audio error:', e);
            console.error('[Renderer] Audio error details:', audio?.error);
            statusDiv.textContent = 'Error loading audio';
        });

        // Setup progress bar listeners
        setupAudioProgressListeners();

        // Update media session with new track
        setupMediaSession(nextMP3);

        // Auto-play if currently playing
        if (isPlaying) {
            playAudio();
        } else {
            statusDiv.textContent = 'Ready to play';
        }
    }
}

// Card flip functions
function flipToSettings() {
    card.classList.add('is-flipped');
    loadSettings();
}

function flipToPlayer() {
    card.classList.remove('is-flipped');
}

// Settings functions
async function loadSettings() {
    await loadFolder();
    await loadAcoustidKey();
    await loadMoodModes();
}

async function loadFolder() {
    const folder = await window.electronAPI.getMusicFolder();
    renderFolder(folder);
}

function renderFolder(folder: string) {
    if (!folder) {
        folderDisplay.textContent = 'No folder configured yet';
        folderDisplay.classList.add('empty');
        return;
    }
    folderDisplay.textContent = folder;
    folderDisplay.title = folder;
    folderDisplay.classList.remove('empty');
}

async function loadAcoustidKey() {
    const key = await window.electronAPI.getAcoustidKey();
    acoustidKeyInput.value = key;
}

// Mood modes functions
async function loadMoodModes() {
    currentMoodModes = await window.electronAPI.getMoodModes();
    renderMoodModes();
    updateMoodModeSelect();
}

function updateMoodModeSelect() {
    // Update the mood mode dropdown with current modes
    const currentValue = moodModeSelect.value;
    moodModeSelect.innerHTML = '<option value="all">All</option>';
    for (const mode of currentMoodModes) {
        const option = document.createElement('option');
        option.value = mode.name;
        option.textContent = mode.name.charAt(0).toUpperCase() + mode.name.slice(1);
        moodModeSelect.appendChild(option);
    }
    // Restore selection if still valid
    if (currentMoodModes.some((m) => m.name === currentValue) || currentValue === 'all') {
        moodModeSelect.value = currentValue;
    }
}

function formatRule(param: string, rule: MoodParameterRule | undefined): string {
    if (!rule) {
        return '';
    }
    const parts = [];
    if (rule.min !== undefined) {
        parts.push(`>=${rule.min}`);
    }
    if (rule.max !== undefined) {
        parts.push(`<=${rule.max}`);
    }
    if (parts.length === 0) {
        return '';
    }
    return `${param}: ${parts.join(' & ')}`;
}

function renderMoodModes() {
    moodModesList.innerHTML = '';

    for (let i = 0; i < currentMoodModes.length; i++) {
        const mode = currentMoodModes[i];
        const item = document.createElement('div');
        item.className = 'mood-mode-item';

        // Build rules display
        const ruleTexts: string[] = [];
        const rules = mode.rules;
        if (rules.danceability) {
            ruleTexts.push(formatRule('Dance', rules.danceability));
        }
        if (rules.happy) {
            ruleTexts.push(formatRule('Happy', rules.happy));
        }
        if (rules.sad) {
            ruleTexts.push(formatRule('Sad', rules.sad));
        }
        if (rules.aggressive) {
            ruleTexts.push(formatRule('Aggr', rules.aggressive));
        }
        if (rules.relaxed) {
            ruleTexts.push(formatRule('Relax', rules.relaxed));
        }

        const rulesHtml =
            ruleTexts.length > 0
                ? ruleTexts.map((r) => `<span class="mood-mode-rule">${r}</span>`).join('')
                : '<span class="mood-mode-default">No rules (matches all)</span>';

        item.innerHTML = `
            <div class="mood-mode-header">
                <span class="mood-mode-name">${mode.name}</span>
                <span class="mood-mode-logic">${mode.logic}</span>
            </div>
            <div class="mood-mode-rules">${rulesHtml}</div>
            ${mode.isDefault ? '<div class="mood-mode-default">Default mode</div>' : ''}
            <div class="mood-mode-actions">
                <button class="mood-mode-btn edit-btn" data-index="${i}">Edit</button>
                <button class="mood-mode-btn delete" data-index="${i}">Delete</button>
            </div>
        `;

        moodModesList.appendChild(item);
    }

    // Add event listeners for edit/delete buttons
    moodModesList.querySelectorAll('.edit-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            const index = parseInt((e.target as HTMLElement).dataset.index || '0');
            openMoodModeModal(index);
        });
    });

    moodModesList.querySelectorAll('.delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const index = parseInt((e.target as HTMLElement).dataset.index || '0');
            await deleteMoodMode(index);
        });
    });
}

function openMoodModeModal(index: number | null = null) {
    editingModeIndex = index;

    if (index !== null && currentMoodModes[index]) {
        const mode = currentMoodModes[index];
        modalTitle.textContent = 'Edit Mood Mode';
        modalModeName.value = mode.name;
        modalLogic.value = mode.logic;
        modalIsDefault.checked = mode.isDefault || false;

        // Fill rule inputs
        ruleDanceMin.value = mode.rules.danceability?.min?.toString() || '';
        ruleDanceMax.value = mode.rules.danceability?.max?.toString() || '';
        ruleHappyMin.value = mode.rules.happy?.min?.toString() || '';
        ruleHappyMax.value = mode.rules.happy?.max?.toString() || '';
        ruleSadMin.value = mode.rules.sad?.min?.toString() || '';
        ruleSadMax.value = mode.rules.sad?.max?.toString() || '';
        ruleAggressiveMin.value = mode.rules.aggressive?.min?.toString() || '';
        ruleAggressiveMax.value = mode.rules.aggressive?.max?.toString() || '';
        ruleRelaxedMin.value = mode.rules.relaxed?.min?.toString() || '';
        ruleRelaxedMax.value = mode.rules.relaxed?.max?.toString() || '';
    } else {
        modalTitle.textContent = 'Add Mood Mode';
        modalModeName.value = '';
        modalLogic.value = 'AND';
        modalIsDefault.checked = false;

        // Clear rule inputs
        ruleDanceMin.value = '';
        ruleDanceMax.value = '';
        ruleHappyMin.value = '';
        ruleHappyMax.value = '';
        ruleSadMin.value = '';
        ruleSadMax.value = '';
        ruleAggressiveMin.value = '';
        ruleAggressiveMax.value = '';
        ruleRelaxedMin.value = '';
        ruleRelaxedMax.value = '';
    }

    moodModeModal.classList.add('active');
}

function closeMoodModeModal() {
    moodModeModal.classList.remove('active');
    editingModeIndex = null;
}

function parseRuleValue(value: string): number | undefined {
    const num = parseInt(value);
    return isNaN(num) ? undefined : Math.min(9, Math.max(0, num));
}

function buildRuleFromInputs(
    minInput: HTMLInputElement,
    maxInput: HTMLInputElement
): MoodParameterRule | undefined {
    const min = parseRuleValue(minInput.value);
    const max = parseRuleValue(maxInput.value);
    if (min === undefined && max === undefined) {
        return undefined;
    }
    return {min, max};
}

async function saveMoodMode() {
    const name = modalModeName.value.trim().toLowerCase();
    if (!name) {
        alert('Please enter a mode name');
        return;
    }

    // Check for duplicate names (except when editing the same mode)
    const duplicateIndex = currentMoodModes.findIndex((m) => m.name === name);
    if (duplicateIndex !== -1 && duplicateIndex !== editingModeIndex) {
        alert('A mode with this name already exists');
        return;
    }

    const newMode: MoodModeDefinition = {
        name,
        logic: modalLogic.value as 'AND' | 'OR',
        isDefault: modalIsDefault.checked,
        rules: {},
    };

    // Build rules from inputs
    const danceRule = buildRuleFromInputs(ruleDanceMin, ruleDanceMax);
    const happyRule = buildRuleFromInputs(ruleHappyMin, ruleHappyMax);
    const sadRule = buildRuleFromInputs(ruleSadMin, ruleSadMax);
    const aggressiveRule = buildRuleFromInputs(ruleAggressiveMin, ruleAggressiveMax);
    const relaxedRule = buildRuleFromInputs(ruleRelaxedMin, ruleRelaxedMax);

    if (danceRule) {
        newMode.rules.danceability = danceRule;
    }
    if (happyRule) {
        newMode.rules.happy = happyRule;
    }
    if (sadRule) {
        newMode.rules.sad = sadRule;
    }
    if (aggressiveRule) {
        newMode.rules.aggressive = aggressiveRule;
    }
    if (relaxedRule) {
        newMode.rules.relaxed = relaxedRule;
    }

    // Update or add mode
    if (editingModeIndex !== null) {
        currentMoodModes[editingModeIndex] = newMode;
    } else {
        currentMoodModes.push(newMode);
    }

    // Save to backend
    await window.electronAPI.setMoodModes(currentMoodModes);

    closeMoodModeModal();
    renderMoodModes();
    updateMoodModeSelect();
}

async function deleteMoodMode(index: number) {
    const mode = currentMoodModes[index];
    if (!confirm(`Delete mood mode "${mode.name}"?`)) {
        return;
    }

    currentMoodModes.splice(index, 1);
    await window.electronAPI.setMoodModes(currentMoodModes);
    renderMoodModes();
    updateMoodModeSelect();
}

// Mood mode editor event listeners
addMoodModeBtn.addEventListener('click', () => openMoodModeModal(null));
modalCancel.addEventListener('click', closeMoodModeModal);
modalSave.addEventListener('click', saveMoodMode);

// Close modal on overlay click
moodModeModal.addEventListener('click', (e) => {
    if (e.target === moodModeModal) {
        closeMoodModeModal();
    }
});

// Event listeners
playButton.addEventListener('click', togglePlay);
nextButton.addEventListener('click', nextSong);
settingsButton.addEventListener('click', flipToSettings);
backButton.addEventListener('click', flipToPlayer);

// Settings event listeners
changeFolderBtn.addEventListener('click', async () => {
    const folder = await window.electronAPI.setMusicFolder();
    renderFolder(folder);
});

reloadBtn.addEventListener('click', async () => {
    await window.electronAPI.reloadMP3();
    reloadBtn.textContent = 'Reloaded!';
    setTimeout(() => {
        reloadBtn.textContent = 'Reload Music';
    }, 1500);
});

saveAcoustidBtn.addEventListener('click', async () => {
    const key = acoustidKeyInput.value.trim();
    await window.electronAPI.setAcoustidKey(key);
    saveAcoustidBtn.textContent = 'Saved!';
    setTimeout(() => {
        saveAcoustidBtn.textContent = 'Save API Key';
    }, 1500);
});

// Listen for media key events from main process
window.electronAPI.onTogglePlay(() => {
    togglePlay();
});

// Listen for next song events from main process (F9 key)
window.electronAPI.onNextSong(() => {
    nextSong();
});

// Listen for show settings events from main process (Cmd+,)
window.electronAPI.onShowSettings(() => {
    flipToSettings();
});

// Listen for MP3 reload events
window.electronAPI.onMP3Reloaded(() => {
    console.log('[Renderer] MP3 reloaded, refreshing...');
    // Stop current audio if playing
    if (audio) {
        audio.pause();
        audio = null;
    }
    isPlaying = false;
    updatePlayButton();
    playButton.disabled = false;
    // Reload MP3 info
    loadMP3Info();
});

// Listen for playlist updates (when songs become available)
window.electronAPI.onPlaylistUpdated(() => {
    console.log('[Renderer] Playlist updated, refreshing MP3 info...');
    // If we don't have audio loaded yet (initial load), load it now
    if (!audio) {
        loadMP3Info();
    }
});

// Initialize mood analyzer worker
async function initializeMoodAnalyzer() {
    try {
        console.log('[Renderer] Initializing mood analyzer worker...');
        const success = await workerManager.initialize();
        if (success) {
            moodAnalyzerInitialized = true;
            console.log('[Renderer] Mood analyzer worker initialized successfully');
        } else {
            console.warn('[Renderer] Mood analyzer worker initialization failed');
        }
    } catch (error) {
        console.error('[Renderer] Error initializing mood analyzer worker:', error);
    }
}

// Background mood analysis handler for playlistTracker
async function handleMoodAnalysisRequest(filePath: string): Promise<void> {
    if (!moodAnalyzerInitialized) {
        console.warn('[Renderer] Mood analyzer not ready for background analysis');
        return;
    }

    // Check if file already has mood code (skip files that have real mood codes)
    const fileName = filePath.split('/').pop() || '';
    if (/[-_]A#\d{5}/.test(fileName) && !fileName.includes('A#55555')) {
        console.log('[Renderer] Background file already has mood code, skipping:', fileName);
        return;
    }

    try {
        console.log('[Renderer] Background mood analysis requested for:', filePath);

        const analysis = await workerManager.analyzeFile(filePath);

        if (analysis) {
            console.log('[Renderer] Background mood analysis complete for:', filePath);

            // Rename file with mood code and BPM
            const result = await window.electronAPI.renameFileWithMood(
                filePath,
                analysis.scores,
                analysis.bpm
            );

            if (result.success) {
                console.log('[Renderer] Background file renamed successfully:', result.newPath);
            } else {
                console.error('[Renderer] Background file rename failed:', result.error);
            }
        } else {
            console.error('[Renderer] Background mood analysis failed for:', filePath);
        }
    } catch (error: any) {
        console.error('[Renderer] Error in background mood analysis:', error);
    }
}

// Listen for background mood analysis requests from main process
window.electronAPI.onAnalyzeMoodRequest((filePath: string) => {
    handleMoodAnalysisRequest(filePath);
});

// Convert mood scores to 5-digit code
function formatMoodCode(scores: MoodScores): string {
    const digits = [
        scores.danceability,
        scores.happy,
        scores.sad,
        scores.aggressive,
        scores.relaxed,
    ]
        .map((score: number) => {
            if (isNaN(score)) {
                return 5;
            }
            return Math.round(score * 9);
        })
        .map((digit: number) => Math.min(9, Math.max(0, digit)))
        .join('');
    return digits;
}

// Batch mood analysis handler
async function handleMoodBatchRequest(filePaths: string[], batchId: string): Promise<void> {
    console.log(`[Renderer] Batch mood analysis requested: ${batchId} (${filePaths.length} files)`);

    if (!moodAnalyzerInitialized) {
        console.warn('[Renderer] Mood analyzer not ready for batch analysis');
        // Send failure for all files
        for (const filePath of filePaths) {
            await window.electronAPI.sendMoodBatchResult(
                batchId,
                filePath,
                false,
                undefined,
                undefined,
                'Mood analyzer not initialized'
            );
        }
        await window.electronAPI.sendMoodBatchComplete(batchId);
        return;
    }

    // Process files sequentially to avoid overwhelming the worker
    for (const filePath of filePaths) {
        try {
            const fileName = filePath.split('/').pop() || '';

            // Skip files that already have real mood codes
            if (/[-_]A#\d{5}/.test(fileName) && !fileName.includes('A#55555')) {
                console.log(`[Renderer] Batch: File already has mood code, skipping: ${fileName}`);
                // Extract existing mood code from filename
                const moodMatch = fileName.match(/A#(\d{5})/);
                const bpmMatch = fileName.match(/B#(\d+)/);
                await window.electronAPI.sendMoodBatchResult(
                    batchId,
                    filePath,
                    true,
                    moodMatch?.[1],
                    bpmMatch ? parseInt(bpmMatch[1]) : undefined
                );
                continue;
            }

            console.log(`[Renderer] Batch: Analyzing ${fileName}`);
            const analysis = await workerManager.analyzeFile(filePath);

            if (analysis) {
                const moodCode = formatMoodCode(analysis.scores);
                console.log(
                    `[Renderer] Batch: Analysis complete for ${fileName}: ${moodCode}, BPM: ${analysis.bpm}`
                );
                await window.electronAPI.sendMoodBatchResult(
                    batchId,
                    filePath,
                    true,
                    moodCode,
                    analysis.bpm
                );
            } else {
                console.error(`[Renderer] Batch: Analysis failed for ${fileName}`);
                await window.electronAPI.sendMoodBatchResult(
                    batchId,
                    filePath,
                    false,
                    undefined,
                    undefined,
                    'Analysis returned null'
                );
            }
        } catch (error: any) {
            console.error(`[Renderer] Batch: Error analyzing ${filePath}:`, error);
            await window.electronAPI.sendMoodBatchResult(
                batchId,
                filePath,
                false,
                undefined,
                undefined,
                error.message || 'Unknown error'
            );
        }
    }

    console.log(`[Renderer] Batch ${batchId} processing complete`);
    await window.electronAPI.sendMoodBatchComplete(batchId);
}

// Listen for batch mood analysis requests from main process
window.electronAPI.onAnalyzeMoodBatchRequest((filePaths: string[], batchId: string) => {
    handleMoodBatchRequest(filePaths, batchId);
});

// Initialize
loadMP3Info();

// Load and display version
(async () => {
    const version = await window.electronAPI.getAppVersion();
    const versionSpan = document.getElementById('version');
    if (versionSpan) {
        versionSpan.textContent = `v${version}`;
    }
})();

// Restore saved mood mode and load mood modes for dropdown
(async () => {
    // First load mood modes to populate the dropdown
    currentMoodModes = await window.electronAPI.getMoodModes();
    updateMoodModeSelect();

    // Then restore the saved selection
    const savedMoodMode = await window.electronAPI.getMoodMode();
    moodModeSelect.value = savedMoodMode;
    console.log('[Renderer] Restored mood mode:', savedMoodMode);
})();

// Initialize mood analyzer after a short delay (let other things load first)
setTimeout(() => {
    initializeMoodAnalyzer();
}, 1000);
