export interface PluginInstance {
    instanceId: string;
    label: string;
    /** Canonical host-bound path; never transported in the page URL. */
    documentPath?: string;
}
export interface CurrentPluginInstance extends PluginInstance {
    /** Reflects native visibility. Newly created hidden instances start inactive. */
    active: boolean;
}
export interface PluginInstanceActivity {
    active: boolean;
    instanceId?: string;
}
/** Host-owned document instances (window.otools.apiVersion >= 5). */
export interface PluginInstancesApi {
    open(options: {
        files: string[];
        reuse?: 'document' | 'new';
    }): Promise<PluginInstance[]>;
    current(): Promise<CurrentPluginInstance | null>;
    onActivity(handler: (event: PluginInstanceActivity) => void): Promise<() => void>;
}
