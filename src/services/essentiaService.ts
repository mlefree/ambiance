// Essentia.js service for mood classification
// This service analyzes audio files and returns mood/classification scores

export interface MoodScores {
    danceability: number; // 0-1
    happy: number; // 0-1
    sad: number; // 0-1
    aggressive: number; // 0-1
    relaxed: number; // 0-1
}

// Convert 0-1 score to 0-9 scale
export function scoreToDigit(score: number): number {
    return Math.round(Math.min(Math.max(score, 0), 1) * 9);
}

// Format mood scores as a 5-digit string
export function formatMoodCode(scores: MoodScores): string {
    return [
        scoreToDigit(scores.danceability),
        scoreToDigit(scores.happy),
        scoreToDigit(scores.sad),
        scoreToDigit(scores.aggressive),
        scoreToDigit(scores.relaxed),
    ].join('');
}

// Check if file already has mood classification
export function hasMoodCode(filename: string): boolean {
    return /[-_]A#\d{5}/.test(filename);
}

// Generate new filename with mood code and BPM
// Input: "song-A#55555-B#120.mp3", "69999", 127
// Output: "song-A#69999-B#127.mp3"
export function generateFilenameWithMoodCode(
    originalFilename: string,
    moodCode: string,
    bpm?: number
): string {
    // Remove existing mood code and BPM if present
    let cleaned = originalFilename.replace(/[-_]A#\d{5}/g, '');
    cleaned = cleaned.replace(/[-_]B#\d+/g, '');

    // Split filename and extension
    const lastDot = cleaned.lastIndexOf('.');
    if (lastDot === -1) {
        const bpmPart = bpm !== undefined ? `-B#${Math.round(bpm)}` : '';
        return `${cleaned}-A#${moodCode}${bpmPart}`;
    }

    const name = cleaned.substring(0, lastDot);
    const ext = cleaned.substring(lastDot);

    const bpmPart = bpm !== undefined ? `-B#${Math.round(bpm)}` : '';
    return `${name}-A#${moodCode}${bpmPart}${ext}`;
}
