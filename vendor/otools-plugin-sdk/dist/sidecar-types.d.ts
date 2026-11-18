export interface SidecarSpawnOptions {
    cwd?: string;
    env?: Record<string, string>;
    lifetime?: 'plugin' | 'view';
}
export interface SidecarHandle {
    handle: string;
    pid: number;
}
export type SidecarEvent = {
    handle: string;
    event: 'output';
    stream: 'stdout' | 'stderr';
    data: string;
} | {
    handle: string;
    event: 'overflow';
    stream: 'stdout' | 'stderr';
} | {
    handle: string;
    event: 'exit';
    code: number | null;
};
export interface SidecarApi {
    spawn(id: string, args?: string[], options?: SidecarSpawnOptions): Promise<SidecarHandle>;
    writeStdin(handle: string, data: string): Promise<void>;
    kill(handle: string, force?: boolean): Promise<void>;
    status(handle: string): Promise<{
        state: 'running';
        pid: number;
    }>;
    onEvent(handler: (event: SidecarEvent) => void): Promise<() => void>;
}
