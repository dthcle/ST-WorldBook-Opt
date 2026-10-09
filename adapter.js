// Native SillyTavern adapter. No credentials or remote script imports.
export async function createAdapter(dependencies) {
    const core = dependencies?.core ?? await import('/script.js');
    const wi = dependencies?.wi ?? await import('/scripts/world-info.js');
    const accountStorage = dependencies?.accountStorage ?? (await import('/scripts/util/AccountStorage.js')).accountStorage;
    const requestFetch = dependencies?.fetch ?? globalThis.fetch;
    if (!wi.worldInfoCache?.set || !core.getRequestHeaders) throw new Error('当前酒馆版本缺少世界书接口');
    async function request(path, body) {
        const response = await requestFetch(path, { method: 'POST', headers: core.getRequestHeaders(), body: JSON.stringify(body), cache: 'no-store' });
        if (!response.ok) throw new Error(`世界书请求失败：HTTP ${response.status}`);
        return response;
    }
    return {
        async list() { const data = await (await request('/api/settings/get', {})).json(); return data.world_names ?? []; },
        async read(name) { return (await request('/api/worldinfo/get', { name })).json(); },
        cached(name) { return wi.worldInfoCache.get(name); },
        async write(name, data) {
            await request('/api/worldinfo/edit', { name, data });
            wi.worldInfoCache.set(name, structuredClone(data));
            try { await core.eventSource.emit(core.event_types.WORLDINFO_UPDATED, name, data); }
            catch (error) { console.warn('[WorldBook Opt] 已保存，但世界书更新事件失败', error); }
        },
        getBackups() { return JSON.parse(accountStorage.getItem('ST-WorldBook-Opt.backups.v1') || '[]'); },
        putBackups(items) { accountStorage.setItem('ST-WorldBook-Opt.backups.v1', JSON.stringify(items)); },
    };
}
