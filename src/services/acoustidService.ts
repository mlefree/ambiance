import fetch from 'node-fetch';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import {promisify} from 'util';

const execAsync = promisify(childProcess.exec);

export interface AcoustIDMetadata {
    title?: string;
    artist?: string;
    album?: string;
    releaseDate?: string;
    duration?: number;
    recordingId?: string;
    score?: number;
}

export class AcoustIDService {
    private apiKey: string;
    private apiUrl = 'https://api.acoustid.org/v2/lookup';
    private lastRequestTime = 0;
    private minRequestInterval = 30000; // 30 seconds rate limit

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    // Check if AcoustID is available (not rate-limited) without waiting
    public isAvailable(): boolean {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        return timeSinceLastRequest >= this.minRequestInterval;
    }

    // Main method: get metadata for an MP3 file
    async getMetadata(filePath: string): Promise<AcoustIDMetadata | null> {
        console.log('[AcoustID] Getting metadata for:', filePath);

        // Generate fingerprint
        const fingerprint = await this.generateFingerprint(filePath);
        if (!fingerprint) {
            console.log('[AcoustID] Could not generate fingerprint');
            return null;
        }

        console.log(`[AcoustID] Generated fingerprint (duration: ${fingerprint.duration}s)`);

        // Query API
        const metadata = await this.queryAPI(fingerprint.fingerprint, fingerprint.duration);

        if (metadata) {
            console.log(
                `[AcoustID] Found metadata: "${metadata.title}" by ${metadata.artist} (score: ${metadata.score})`
            );
        } else {
            console.log('[AcoustID] No metadata found');
        }

        return metadata;
    }

    // Rate limiting: ensure minimum interval between requests
    private async waitForRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }

    // Common fpcalc locations (Homebrew on Apple Silicon, Intel, and PATH fallback)
    private static FPCALC_PATHS = [
        '/opt/homebrew/bin/fpcalc', // Homebrew on Apple Silicon
        '/usr/local/bin/fpcalc', // Homebrew on Intel Mac
        'fpcalc', // PATH fallback
    ];

    // Find working fpcalc path (cached after first successful find)
    private fpcalcPath: string | null = null;

    private async findFpcalc(): Promise<string | null> {
        if (this.fpcalcPath) {
            return this.fpcalcPath;
        }

        console.log(
            `[AcoustID] Searching for fpcalc in: ${AcoustIDService.FPCALC_PATHS.join(', ')}`
        );

        for (const fpcalcPath of AcoustIDService.FPCALC_PATHS) {
            try {
                // Test if this path works by checking if file exists (for absolute paths)
                if (fpcalcPath.startsWith('/')) {
                    if (fs.existsSync(fpcalcPath)) {
                        this.fpcalcPath = fpcalcPath;
                        console.log(`[AcoustID] Found fpcalc at: ${fpcalcPath}`);
                        return fpcalcPath;
                    } else {
                        console.log(`[AcoustID] fpcalc not found at: ${fpcalcPath}`);
                    }
                } else {
                    // For PATH-based lookup, try to execute
                    await execAsync(`which "${fpcalcPath}" 2>/dev/null`);
                    this.fpcalcPath = fpcalcPath;
                    console.log(`[AcoustID] Found fpcalc in PATH: ${fpcalcPath}`);
                    return fpcalcPath;
                }
            } catch {
                console.log(`[AcoustID] fpcalc not in PATH`);
            }
        }

        console.error(
            '[AcoustID] fpcalc not found anywhere. Install Chromaprint: brew install chromaprint'
        );
        return null;
    }

    // Generate audio fingerprint using fpcalc (part of Chromaprint)
    private async generateFingerprint(
        filePath: string
    ): Promise<{duration: number; fingerprint: string} | null> {
        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                console.error('[AcoustID] File not found:', filePath);
                return null;
            }

            // Find fpcalc binary
            const fpcalc = await this.findFpcalc();
            if (!fpcalc) {
                return null;
            }

            // Run fpcalc with full path
            const {stdout} = await execAsync(`"${fpcalc}" -json "${filePath}"`);
            const result = JSON.parse(stdout);

            if (result.fingerprint && result.duration) {
                return {
                    duration: result.duration,
                    fingerprint: result.fingerprint,
                };
            }

            return null;
        } catch (error: any) {
            // Check if fpcalc is not installed
            if (error.message?.includes('command not found') || error.code === 'ENOENT') {
                console.error(
                    '[AcoustID] fpcalc not found. Install Chromaprint: brew install chromaprint'
                );
            } else {
                console.error('[AcoustID] Error generating fingerprint:', error);
            }
            return null;
        }
    }

    // Query AcoustID API with fingerprint
    private async queryAPI(
        fingerprint: string,
        duration: number
    ): Promise<AcoustIDMetadata | null> {
        try {
            await this.waitForRateLimit();

            const params = new URLSearchParams({
                client: this.apiKey,
                duration: Math.floor(duration).toString(),
                fingerprint: fingerprint,
                meta: 'recordings releasegroups',
            });

            // Add timeout to prevent hanging on network issues
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

            try {
                const response = await fetch(`${this.apiUrl}?${params}`, {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);

                const data: any = await response.json();

                if (!response.ok) {
                    console.error('[AcoustID] API error:', response.status, response.statusText);
                    console.error('[AcoustID] Response:', JSON.stringify(data, null, 2));
                    return null;
                }

                if (data.status !== 'ok') {
                    console.error(
                        '[AcoustID] API returned error status:',
                        data.status,
                        JSON.stringify(data)
                    );
                    return null;
                }

                console.log(
                    `[AcoustID] API response: status=${data.status}, results=${data.results?.length || 0}`
                );

                // Extract best result
                if (data.results && data.results.length > 0) {
                    const bestResult = data.results[0];
                    console.log(
                        `[AcoustID] Best result: score=${bestResult.score}, recordings=${bestResult.recordings?.length || 0}`
                    );

                    if (bestResult.recordings && bestResult.recordings.length > 0) {
                        const recording = bestResult.recordings[0];
                        const releaseGroup = recording.releasegroups?.[0];
                        console.log(
                            `[AcoustID] Recording: title="${recording.title}", artist="${recording.artists?.[0]?.name}"`
                        );

                        return {
                            title: recording.title,
                            artist: recording.artists?.[0]?.name,
                            album: releaseGroup?.title,
                            releaseDate: releaseGroup?.['first-release-date'],
                            duration: recording.duration,
                            recordingId: recording.id,
                            score: bestResult.score,
                        };
                    } else {
                        console.log(
                            `[AcoustID] Result has no recordings (score=${bestResult.score})`
                        );
                    }
                } else {
                    console.log(`[AcoustID] API returned empty results array`);
                }

                return null;
            } catch (fetchError: any) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    console.error('[AcoustID] API request timed out after 10 seconds');
                } else {
                    throw fetchError;
                }
                return null;
            }
        } catch (error) {
            console.error('[AcoustID] Error querying API:', error);
            return null;
        }
    }
}
