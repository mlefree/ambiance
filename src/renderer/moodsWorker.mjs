// Web Worker for mood analysis using Essentia.js and TensorFlow.js
// This worker runs in a separate thread to avoid blocking the main UI

// Load TensorFlow.js and Essentia.js in web worker context
// getBackend,
//     loadGraphModel,
//     ready,
//     setBackend,
//     tidy
// import {getBackend, setBackend} from '../../node_modules/@tensorflow/tfjs-core/dist/tf-core.es2017.js';
// import '../../node_modules/@tensorflow/tfjs-backend-wasm/dist/tf-backend-wasm.es2017.js';
import {getBackend, loadGraphModel, ready, tidy, tensor} from '../../node_modules/@tensorflow/tfjs/dist/tf.fesm.js';


import {EssentiaWASM} from '../../node_modules/essentia.js/dist/essentia-wasm.es.js';
import Essentia from '../../node_modules/essentia.js/dist/essentia.js-core.es.js';


// Model paths relative to the worker file location
// Models are at: models/
const MODEL_PATHS = {
    danceability: '../../models/danceability-musicnn-msd-2/model.json',
    happy: '../../models/mood_happy-musicnn-msd-2/model.json',
    sad: '../../models/mood_sad-musicnn-msd-2/model.json',
    aggressive: '../../models/mood_aggressive-musicnn-msd-2/model.json',
    relaxed: '../../models/mood_relaxed-musicnn-msd-2/model.json',
};

// Worker state
let isInitialized = false;
let essentia = null;
const models = new Map();

// Initialize Essentia and TensorFlow models
async function initialize() {
    try {
        console.log('[MoodsWorker] Initializing...');

        // Load Essentia WASM
        if (typeof EssentiaWASM === 'undefined') {
            throw new Error('EssentiaWASM not available in worker');
        }

        essentia = new Essentia(EssentiaWASM);
        console.log('[MoodsWorker] Essentia WASM initialized');

        // Initialize TensorFlow backend
        // if (typeof tf === 'undefined') {
        //     throw new Error('TensorFlow not available in worker');
        // }

        // await setBackend('wasm');
        // await setWasmPath('wasm');
        const tfReady = await ready();
        console.log(`[MoodsWorker] TensorFlow ready:${tfReady} and backend:`, getBackend());

        // Load all models
        await loadModels();

        isInitialized = true;
        console.log('[MoodsWorker] Initialization complete');

        return {
            type: 'initialize-result',
            success: true,
        };
    } catch (error) {
        console.error('[MoodsWorker] Initialization error:', error);
        return {
            type: 'initialize-result',
            success: false,
            error: error.message,
        };
    }
}

// Load TensorFlow models
async function loadModels() {
    console.log('[MoodsWorker] Loading TensorFlow models...');

    for (const [name, path] of Object.entries(MODEL_PATHS)) {
        try {
            console.log(`[MoodsWorker] Loading ${name} model from ${path}`);
            const model = await loadGraphModel(path);
            models.set(name, model);
            console.log(`[MoodsWorker] ${name} model loaded successfully`);
        } catch (error) {
            console.warn(`[MoodsWorker] Failed to load ${name} model:`, error);
        }
    }

    console.log(`[MoodsWorker] Loaded ${models.size}/${Object.keys(MODEL_PATHS).length} models`);
}

// Extract BPM from audio signal using simpler PercivalBpmEstimator
function extractBPM(audioSignal, sampleRate) {
    try {
        // Use only first 30 seconds for BPM to avoid long processing times
        const maxSamples = sampleRate * 30;
        const truncatedSignal = audioSignal.length > maxSamples
            ? audioSignal.slice(0, maxSamples)
            : audioSignal;

        const vectorSignal = essentia.arrayToVector(truncatedSignal);

        // Try simpler PercivalBpmEstimator first (faster)
        try {
            const result = essentia.PercivalBpmEstimator(vectorSignal);
            const bpm = result.bpm || 120;
            console.log(`[MoodsWorker] Detected BPM (Percival): ${bpm}`);
            return Math.round(bpm);
        } catch (e) {
            console.warn('[MoodsWorker] PercivalBpmEstimator failed:', e.message);
        }

        // Fallback: try RhythmExtractor2013 with defaults
        try {
            const rhythm = essentia.RhythmExtractor2013(vectorSignal);
            const bpm = rhythm.bpm || 120;
            console.log(`[MoodsWorker] Detected BPM (RhythmExtractor): ${bpm}`);
            return Math.round(bpm);
        } catch (e) {
            console.warn('[MoodsWorker] RhythmExtractor2013 failed:', e.message);
        }

        return 120;
    } catch (error) {
        console.warn('[MoodsWorker] BPM extraction failed, using default:', error);
        return 120;
    }
}

// Extract mel spectrogram from audio signal using MusiCNN parameters
function extractMelSpectrogram(audioSignal, sampleRate) {
    try {
        const frameSize = 512;
        const hopSize = 256;
        const numberBands = 96;
        const melSpectrogram = [];

        // Process frames manually with overlapping windows
        for (
            let i = 0;
            i + frameSize <= audioSignal.length && melSpectrogram.length < 187;
            i += hopSize
        ) {
            const frameData = audioSignal.slice(i, i + frameSize);
            const frame = essentia.arrayToVector(frameData);

            // Check if TensorflowInputMusiCNN is available
            if (typeof essentia.TensorflowInputMusiCNN === 'function') {
                // TensorflowInputMusiCNN does all the preprocessing
                const musiCNNInput = essentia.TensorflowInputMusiCNN(frame);

                const bandsArray = [];
                for (let j = 0; j < numberBands; j++) {
                    bandsArray.push(musiCNNInput.bands.get(j));
                }
                melSpectrogram.push(bandsArray);
            } else {
                // Fallback to manual extraction
                const windowed = essentia.Windowing(frame, true, frameSize, 'hann', true, false);
                const spectrum = essentia.Spectrum(windowed.frame, frameSize);
                const melBands = essentia.MelBands(
                    spectrum.spectrum,
                    11025,
                    frameSize / 2 + 1,
                    true,
                    0,
                    '',
                    numberBands,
                    22050,
                    'power',
                    'htk',
                    ''
                );

                const bandsArray = [];
                for (let j = 0; j < numberBands; j++) {
                    bandsArray.push(melBands.bands.get(j));
                }
                melSpectrogram.push(bandsArray);
            }
        }

        console.log(`[MoodsWorker] Processed ${melSpectrogram.length} frames`);
        return melSpectrogram;
    } catch (error) {
        console.error('[MoodsWorker] Error extracting mel spectrogram:', error);
        return null;
    }
}

// Compute mood scores from audio data
async function computeMoodScores(
    audioData,
    sampleRate
) {
    const melSpectrogram = extractMelSpectrogram(audioData, sampleRate);

    if (!melSpectrogram) {
        console.warn('[MoodsWorker] Failed to extract features, using default scores');
        return {
            danceability: 0.5,
            happy: 0.5,
            sad: 0.5,
            aggressive: 0.5,
            relaxed: 0.5,
        };
    }

    // Flatten to 1D array
    const melBandsArray = [];
    for (const frame of melSpectrogram) {
        melBandsArray.push(...frame);
    }

    const numberBands = 96;
    const inputTensor = tidy(() => {
        const t = tensor(melBandsArray);
        const reshaped = t.reshape([1, melSpectrogram.length, numberBands]);
        console.log('[MoodsWorker] Input tensor shape:', reshaped.shape);
        return reshaped;
    });

    // Model tag order defines which class index is the "positive" class
    // [true, false] means index 0 is positive, [false, true] means index 1 is positive
    const modelTagOrder = {
        danceability: [true, false],
        happy: [true, false],
        sad: [false, true],
        aggressive: [true, false],
        relaxed: [false, true],
    };

    const scores = {};

    for (const [name, model] of models.entries()) {
        try {
            const prediction = await model.predict(inputTensor);
            const data = await prediction.data();

            // Select the correct class based on modelTagOrder
            const positiveClassIndex = modelTagOrder[name] ? modelTagOrder[name].indexOf(true) : 0;
            const score = data[positiveClassIndex];

            console.log(`[MoodsWorker] ${name} raw prediction data:`, Array.from(data));
            console.log(`[MoodsWorker] ${name} score (class ${positiveClassIndex}): ${score}`);
            scores[name] = score;

            prediction.dispose();
        } catch (error) {
            console.warn(`[MoodsWorker] Failed to run ${name} model:`, error);
        }
    }

    inputTensor.dispose();

    return {
        danceability: scores.danceability ?? 0.5,
        happy: scores.happy ?? 0.5,
        sad: scores.sad ?? 0.5,
        aggressive: scores.aggressive ?? 0.5,
        relaxed: scores.relaxed ?? 0.5,
    };
}

// Analyze pre-decoded audio data (decoded in main thread where AudioContext is available)
async function analyzeFile(id, filePath, audioData, sampleRate) {
    if (!isInitialized) {
        return {
            type: 'analyze-result',
            id,
            success: false,
            error: 'Worker not initialized',
        };
    }

    try {
        console.log(`[MoodsWorker] Analyzing: ${filePath} (${audioData.length} samples at ${sampleRate}Hz)`);

        const totalDuration = audioData.length / sampleRate;
        const segmentDuration = 10; // seconds per segment
        const segmentSamples = sampleRate * segmentDuration;

        // Extract up to 3 segments (beginning, middle, end) for better mood representation
        const segments = [];
        if (audioData.length <= segmentSamples) {
            // Short audio: use entire track
            segments.push({data: audioData, name: 'full'});
        } else if (audioData.length <= segmentSamples * 2) {
            // Medium audio: use beginning and end
            segments.push({data: audioData.slice(0, segmentSamples), name: 'beginning'});
            segments.push({data: audioData.slice(-segmentSamples), name: 'end'});
        } else {
            // Long audio: use beginning (skip first 10s), middle, and end (skip last 10s)
            const skipSamples = sampleRate * 10; // skip first/last 10 seconds (intros/outros)
            const beginStart = Math.min(skipSamples, audioData.length - segmentSamples);
            segments.push({data: audioData.slice(beginStart, beginStart + segmentSamples), name: 'beginning'});

            const middleStart = Math.floor((audioData.length - segmentSamples) / 2);
            segments.push({data: audioData.slice(middleStart, middleStart + segmentSamples), name: 'middle'});

            const endStart = Math.max(0, audioData.length - skipSamples - segmentSamples);
            segments.push({data: audioData.slice(endStart, endStart + segmentSamples), name: 'end'});
        }

        console.log(`[MoodsWorker] Analyzing ${segments.length} segments from ${Math.round(totalDuration)}s track`);

        // Compute mood scores for each segment and average them
        const allScores = [];
        for (const segment of segments) {
            console.log(`[MoodsWorker] Computing mood for segment: ${segment.name}`);
            const segmentScores = await computeMoodScores(segment.data, sampleRate);
            allScores.push(segmentScores);
            console.log(`[MoodsWorker] Segment ${segment.name} scores:`, segmentScores);
        }

        // Average all segment scores
        const scores = {
            danceability: allScores.reduce((sum, s) => sum + s.danceability, 0) / allScores.length,
            happy: allScores.reduce((sum, s) => sum + s.happy, 0) / allScores.length,
            sad: allScores.reduce((sum, s) => sum + s.sad, 0) / allScores.length,
            aggressive: allScores.reduce((sum, s) => sum + s.aggressive, 0) / allScores.length,
            relaxed: allScores.reduce((sum, s) => sum + s.relaxed, 0) / allScores.length,
        };
        console.log(`[MoodsWorker] Averaged scores:`, scores);

        // Extract BPM from middle segment (or full audio if short)
        const bpmSegment = segments.find(s => s.name === 'middle') || segments[0];
        console.log(`[MoodsWorker] Extracting BPM from ${bpmSegment.name} segment...`);
        const bpm = extractBPM(bpmSegment.data, sampleRate);

        console.log(`[MoodsWorker] Analysis complete for ${filePath}`);

        return {
            type: 'analyze-result',
            id,
            success: true,
            scores,
            bpm,
        };
    } catch (error) {
        console.error(`[MoodsWorker] Error analyzing file ${filePath}:`, error);
        return {
            type: 'analyze-result',
            id,
            success: false,
            error: error.message,
        };
    }
}

// Message handler
self.onmessage = async (event) => {
    const message = event.data;
    console.log(`[MoodsWorker] Received message:`, message);

    try {
        if (message.type === 'initialize') {
            const response = await initialize();
            self.postMessage(response);
        } else if (message.type === 'analyze') {
            if (!message.id || !message.filePath || !message.audioData || !message.sampleRate) {
                console.error('[MoodsWorker] Invalid analyze request:', message);
                const errorResponse = {
                    type: 'analyze-result',
                    id: message.id || 'unknown',
                    success: false,
                    error: 'Invalid request: missing id, filePath, audioData, or sampleRate',
                };
                self.postMessage(errorResponse);
                return;
            }

            const response = await analyzeFile(message.id, message.filePath, message.audioData, message.sampleRate);
            self.postMessage(response);
        } else {
            console.error('[MoodsWorker] Unknown message type:', message);
        }
    } catch (error) {
        console.error('[MoodsWorker] Unhandled error in message handler:', error);
        const errorResponse = {
            type: 'analyze-result',
            id: (message).id || 'unknown',
            success: false,
            error: error.message || 'Unknown error in worker',
        };
        self.postMessage(errorResponse);
    }
};

// Global error handler
self.onerror = (event) => {
    console.error('[MoodsWorker] Global error:', event);
    return true;
};
