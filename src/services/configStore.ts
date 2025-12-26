import Store from 'electron-store';

interface ConfigSchema {
    musicFolder: string;
    acoustidKey: string;
}

const store = new Store<ConfigSchema>({
    defaults: {
        musicFolder: '',
        acoustidKey: '',
    },
});

export class ConfigStore {
    static getMusicFolder(): string {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (store as any).get('musicFolder', '');
    }

    static setMusicFolder(folder: string): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (store as any).set('musicFolder', folder);
    }

    static getAcoustidKey(): string {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (store as any).get('acoustidKey', '');
    }

    static setAcoustidKey(key: string): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (store as any).set('acoustidKey', key);
    }

    static hasConfiguration(): boolean {
        return this.getMusicFolder() !== '';
    }
}
