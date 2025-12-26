// Shared metadata types for file processing

export interface TrackMetadata {
    artist: string;
    album: string;
    trackNumber: string;
    title: string;
    bpm: string;
    genre?: string;
    moodCode?: string;
}

export interface ExtractedMetadata extends TrackMetadata {
    fromAcoustID: boolean;
}

export interface MetadataExtractionResult {
    success: boolean;
    metadata?: ExtractedMetadata;
    error?: string;
    quarantined?: boolean;
}

export interface ProcessingResult {
    success: boolean;
    organizedPath?: string;
    error?: string;
    quarantined?: boolean;
}

// FileMetadata used for file organization (moods instead of moodCode)
export interface FileMetadata {
    artist: string;
    album: string;
    trackNumber: string;
    title: string;
    bpm: string;
    moods: string;
}
