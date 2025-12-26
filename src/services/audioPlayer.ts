import {MP3Info} from '../utils/mp3Finder';

export class AudioPlayer {
    private currentMP3: MP3Info | null = null;
    private isPlaying: boolean = false;
    private playlist: MP3Info[] = [];
    private currentIndex: number = 0;

    constructor() {
        // Audio will be created in the renderer process
    }

    getCurrentMP3(): MP3Info | null {
        return this.currentMP3;
    }

    setPlaylist(playlist: MP3Info[]): void {
        this.playlist = playlist;
    }

    setCurrentIndex(index: number): void {
        this.currentIndex = index;
        if (this.playlist[index]) {
            this.currentMP3 = this.playlist[index];
        }
    }

    getCurrentIndex(): number {
        return this.currentIndex;
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    setIsPlaying(playing: boolean): void {
        this.isPlaying = playing;
    }
}

export const audioPlayer = new AudioPlayer();
