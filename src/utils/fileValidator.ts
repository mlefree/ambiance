import * as fs from 'fs';
import * as path from 'path';
import {parseFile} from 'music-metadata';

export type MoodMode = 'all' | 'calm' | 'neutral' | 'excited' | string;

// Rule for a single mood parameter
export interface MoodParameterRule {
    min?: number; // Minimum value (0-9), inclusive
    max?: number; // Maximum value (0-9), inclusive
}

// Definition of a mood mode with its filtering rules
export interface MoodModeDefinition {
    name: string;
    rules: {
        danceability?: MoodParameterRule;
        happy?: MoodParameterRule;
        sad?: MoodParameterRule;
        aggressive?: MoodParameterRule;
        relaxed?: MoodParameterRule;
    };
    logic: 'AND' | 'OR'; // How to combine rules
    isDefault?: boolean; // If true, matches when no other mode matches
}

// Default mood mode definitions (matching current hardcoded behavior)
export const DEFAULT_MOOD_MODES: MoodModeDefinition[] = [
    {
        name: 'calm',
        rules: {
            relaxed: {min: 6},
            danceability: {max: 4},
            aggressive: {max: 3},
        },
        logic: 'AND',
    },
    {
        name: 'excited',
        rules: {
            danceability: {min: 6},
            aggressive: {min: 6},
        },
        logic: 'OR',
    },
    {
        name: 'neutral',
        rules: {},
        logic: 'AND',
        isDefault: true, // Matches everything not caught by other modes
    },
];

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    metadata?: {
        artist: string;
        album: string;
        trackNumber: string;
        title: string;
        moods: string;
        bpm: string;
    };
}

// Expected format: <artist>-<album>-#<trackNumber>-<title>-A#<moods>-B#<bpm>.mp3
// Note: A# MUST come before B# (not B# before A#)
const FILENAME_REGEX = /^(.+)-(.+)-#(\d+)-(.+)-A#(\d{5})-B#(\d+)\.mp3$/;

/**
 * Validates if a file follows the expected naming convention
 */
export function validateFileName(fileName: string): ValidationResult {
    const errors: string[] = [];

    const match = fileName.match(FILENAME_REGEX);

    if (!match) {
        errors.push(
            'Filename does not match expected format: <artist>-<album>-#<trackNumber>-<title>-A#<moods>-B#<bpm>.mp3'
        );
        return {isValid: false, errors};
    }

    const [, artist, album, trackNumber, title, moods, bpm] = match;

    // Validate mood code is 5 digits (or 7 for legacy files)
    if (moods.length !== 5 && moods.length !== 7) {
        errors.push(`Mood code must be 5 digits (or 7 for legacy), got ${moods.length}`);
    }

    // Validate BPM is reasonable number
    const bpmNum = parseInt(bpm, 10);
    if (bpmNum < 20 || bpmNum > 300) {
        errors.push(`BPM ${bpmNum} seems unreasonable (should be 20-300)`);
    }

    // Validate track number
    const trackNum = parseInt(trackNumber, 10);
    if (trackNum < 1 || trackNum > 999) {
        errors.push(`Track number ${trackNum} seems unreasonable`);
    }

    return {
        isValid: errors.length === 0,
        errors,
        metadata: {artist, album, trackNumber, title, moods, bpm},
    };
}

/**
 * Validates if a file is in the correct directory structure
 * Expected: <AMBIANCE_FOLDER>/<artist>/<album>/<filename>
 */
export function validateFileLocation(filePath: string, baseFolder: string): ValidationResult {
    const errors: string[] = [];

    const relativePath = path.relative(baseFolder, filePath);
    const parts = relativePath.split(path.sep);

    // Should have exactly 3 parts: artist, album, filename
    if (parts.length !== 3) {
        errors.push(`File should be in <artist>/<album>/ structure, got: ${relativePath}`);
        return {isValid: false, errors};
    }

    const [artist, album, fileName] = parts;

    // Validate the filename matches the directory structure
    const fileValidation = validateFileName(fileName);

    if (!fileValidation.isValid) {
        errors.push(...fileValidation.errors);
    } else if (fileValidation.metadata) {
        // Check if artist and album in filename match the directory structure
        const metaArtist = fileValidation.metadata.artist;
        const metaAlbum = fileValidation.metadata.album;

        if (metaArtist !== artist) {
            errors.push(`Artist in filename "${metaArtist}" doesn't match directory "${artist}"`);
        }

        if (metaAlbum !== album) {
            errors.push(`Album in filename "${metaAlbum}" doesn't match directory "${album}"`);
        }
    }

    return {
        isValid: errors.length === 0,
        errors,
        metadata: fileValidation.metadata,
    };
}

/**
 * Validates if a file is a valid MP3 file by checking its format
 */
export async function validateMP3Format(filePath: string): Promise<ValidationResult> {
    const errors: string[] = [];

    try {
        if (!fs.existsSync(filePath)) {
            errors.push('File does not exist');
            return {isValid: false, errors};
        }

        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            errors.push('Path is not a file');
            return {isValid: false, errors};
        }

        if (stats.size === 0) {
            errors.push('File is empty (0 bytes)');
            return {isValid: false, errors};
        }

        // Try to parse as audio file
        const metadata = await parseFile(filePath);

        // Check if it's actually MP3 format
        if (metadata.format.container !== 'MPEG' && metadata.format.codec !== 'MP3') {
            errors.push(
                `File is not MP3 format (detected: ${metadata.format.container || 'unknown'})`
            );
        }

        // Validate duration exists and is reasonable
        if (!metadata.format.duration || metadata.format.duration < 1) {
            errors.push('File has no valid audio duration');
        }
    } catch (error) {
        errors.push(
            `Failed to parse MP3 file: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    return {
        isValid: errors.length === 0,
        errors,
    };
}

/**
 * Performs complete validation of an MP3 file
 */
export async function validateFile(
    filePath: string,
    baseFolder: string
): Promise<ValidationResult> {
    const errors: string[] = [];

    // 1. Check MP3 format validity
    const formatValidation = await validateMP3Format(filePath);
    if (!formatValidation.isValid) {
        errors.push(...formatValidation.errors);
        return {isValid: false, errors};
    }

    // 2. Check file location
    const locationValidation = validateFileLocation(filePath, baseFolder);
    if (!locationValidation.isValid) {
        errors.push(...locationValidation.errors);
    }

    return {
        isValid: errors.length === 0,
        errors,
        metadata: locationValidation.metadata,
    };
}

/**
 * Checks if filename has incorrectly formatted metadata (B# before A#)
 * Example: file-B#120-A#46223.mp3 or file-B#120_A#46223.mp3
 */
export function hasIncorrectMetadataOrder(fileName: string): boolean {
    // Check for B# before A# pattern with either - or _ separator (supports both 5 and 7 digit codes)
    return /B#\d+[-_]A#\d{5}/.test(fileName);
}

/**
 * Fixes incorrectly ordered metadata in filename (B# before A# -> A# before B#)
 * Example: file-B#120_A#46223.mp3 -> file-A#46223-B#120.mp3
 */
export function fixMetadataOrder(fileName: string): string | null {
    const badOrderRegex = /^(.+?)[-_]B#(\d+)[-_]A#(\d{5})(\.mp3)$/;
    const match = fileName.match(badOrderRegex);

    if (!match) {
        return null;
    }

    const [, prefix, bpm, moods, ext] = match;
    return `${prefix}-A#${moods}-B#${bpm}${ext}`;
}

/**
 * Checks if a filename has fallback mood code (A#55555)
 * This indicates the file was processed without proper mood analysis
 */
export function hasFallbackMoodCode(fileName: string): boolean {
    return fileName.includes('A#55555');
}

/**
 * Checks if a file path contains "Unknown Artist" or "Unknown Album"
 * This indicates the file needs AcoustID lookup to complete metadata
 */
export function hasUnknownMetadata(filePath: string): boolean {
    return (
        filePath.includes('Unknown Artist') ||
        filePath.includes('_/') ||
        filePath.includes('Unknown Album')
    );
}

/**
 * Checks if a file is fully compliant (ready for playlist):
 * - Correct filename format
 * - In correct directory structure (artist/album/)
 * - No Unknown Artist/Album
 * - No fallback mood code (A#55555)
 */
export function isFullyCompliant(filePath: string, baseFolder: string): boolean {
    const relativePath = path.relative(baseFolder, filePath);
    const parts = relativePath.split(path.sep);
    const fileName = path.basename(filePath);

    // Must be in artist/album/file structure
    if (parts.length !== 3) {
        return false;
    }

    // Must not start with _ (quarantine)
    if (parts[0].startsWith('_')) {
        return false;
    }

    // Must have valid filename format
    const fileValidation = validateFileName(fileName);
    if (!fileValidation.isValid) {
        return false;
    }

    // Must not have Unknown metadata
    if (hasUnknownMetadata(filePath)) {
        return false;
    }

    // Must not have fallback mood code
    if (hasFallbackMoodCode(fileName)) {
        return false;
    }

    // Directory must match filename metadata
    if (fileValidation.metadata) {
        const [artist, album] = parts;
        if (fileValidation.metadata.artist !== artist || fileValidation.metadata.album !== album) {
            return false;
        }
    }

    return true;
}

// Extract mood values from a mood code string
export function parseMoodCode(moodCode: string): {
    danceability: number;
    happy: number;
    sad: number;
    aggressive: number;
    relaxed: number;
} | null {
    if (!moodCode || moodCode.length !== 5) {
        return null;
    }
    return {
        danceability: parseInt(moodCode[0], 10),
        happy: parseInt(moodCode[1], 10),
        sad: parseInt(moodCode[2], 10),
        aggressive: parseInt(moodCode[3], 10),
        relaxed: parseInt(moodCode[4], 10),
    };
}

// Check if a mood value matches a rule
function matchesRule(value: number, rule?: MoodParameterRule): boolean {
    if (!rule) {
        return true; // No rule = no constraint
    }
    if (rule.min !== undefined && value < rule.min) {
        return false;
    }
    if (rule.max !== undefined && value > rule.max) {
        return false;
    }
    return true;
}

// Check if mood values match a mood mode definition
export function matchesMoodModeDefinition(
    moodValues: {
        danceability: number;
        happy: number;
        sad: number;
        aggressive: number;
        relaxed: number;
    },
    modeDef: MoodModeDefinition
): boolean {
    const {rules, logic} = modeDef;

    // No rules = matches everything (for default mode)
    if (Object.keys(rules).length === 0) {
        return true;
    }

    const results = [
        matchesRule(moodValues.danceability, rules.danceability),
        matchesRule(moodValues.happy, rules.happy),
        matchesRule(moodValues.sad, rules.sad),
        matchesRule(moodValues.aggressive, rules.aggressive),
        matchesRule(moodValues.relaxed, rules.relaxed),
    ];

    if (logic === 'OR') {
        // For OR: at least one defined rule must match
        const definedRules = [
            rules.danceability && matchesRule(moodValues.danceability, rules.danceability),
            rules.happy && matchesRule(moodValues.happy, rules.happy),
            rules.sad && matchesRule(moodValues.sad, rules.sad),
            rules.aggressive && matchesRule(moodValues.aggressive, rules.aggressive),
            rules.relaxed && matchesRule(moodValues.relaxed, rules.relaxed),
        ].filter((r) => r !== undefined);

        return definedRules.some((r) => r === true);
    }

    // AND logic: all rules must match
    return results.every((r) => r);
}

// Extract mood code from filepath and check if it matches the mood mode
// Mood code format: A#DHSAR (Danceability, Happy, Sad, Aggressive, Relaxed)
// Uses stored moodModes definitions, falls back to DEFAULT_MOOD_MODES
export function matchesMoodMode(
    filePath: string,
    moodMode: MoodMode,
    moodModes: MoodModeDefinition[] = DEFAULT_MOOD_MODES
): boolean {
    if (moodMode === 'all') {
        return true;
    }

    const fileName = path.basename(filePath);
    const moodMatch = fileName.match(/A#(\d{5})/);

    if (!moodMatch) {
        return false; // No mood code, exclude from filtered results
    }

    const moodValues = parseMoodCode(moodMatch[1]);
    if (!moodValues) {
        return false;
    }

    // Find the mode definition
    const modeDef = moodModes.find((m) => m.name === moodMode);

    // Handle 'neutral' as default (matches when not matching other non-default modes)
    if (modeDef?.isDefault) {
        const nonDefaultModes = moodModes.filter((m) => !m.isDefault);
        const matchesOther = nonDefaultModes.some((m) => matchesMoodModeDefinition(moodValues, m));
        return !matchesOther;
    }

    if (!modeDef) {
        return true; // Unknown mode, allow all
    }

    return matchesMoodModeDefinition(moodValues, modeDef);
}
