// Dependency-free transaction boundary shared by save and restore.
// Restore is NOT a bypass: the UI passes backup.data as `next` with fresh baselines.
// The newest 20 local backups are retained (oldest first); this is not permanent history.
const MAX_BACKUPS = 20;
const queues = new WeakMap();
let sequence = 0;

function failure(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.code = code;
    return error;
}

/**
 * Canonical JSON text, NOT a cryptographic hash. Object keys are sorted recursively;
 * array order is significant. Root undefined is supported for an absent cache and
 * returns undefined, distinct from null. Non-JSON data is rejected rather than
 * silently dropped/coerced (which would make a deep comparison unsafe).
 */
export function fingerprint(value) {
    const ancestors = new Set();
    function encode(item, root = false) {
        if (item === undefined && root) return undefined;
        if (item === null) return 'null';
        if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
        if (typeof item !== 'object') throw failure('invalid_data', 'Expected JSON data');
        if (ancestors.has(item)) throw failure('invalid_data', 'Circular JSON data');
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
            throw failure('invalid_data', 'Expected a plain JSON object');
        }
        ancestors.add(item);
        try {
            const keys = Reflect.ownKeys(item).filter(key => Object.getOwnPropertyDescriptor(item, key).enumerable);
            if (keys.some(key => typeof key === 'symbol')) throw failure('invalid_data', 'Symbol keys are not JSON data');
            for (const key of keys) {
                if (!('value' in Object.getOwnPropertyDescriptor(item, key))) throw failure('invalid_data', 'JSON accessors are unsupported');
            }
            if (Array.isArray(item)) {
                if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) {
                    throw failure('invalid_data', 'Sparse arrays or extra array properties are not JSON data');
                }
                return `[${item.map(element => encode(element)).join(',')}]`;
            }
            return `{${keys.sort().map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
        } finally {
            ancestors.delete(item);
        }
    }
    return encode(value, true);
}

function snapshot(value) {
    const text = fingerprint(value);
    return text === undefined ? undefined : JSON.parse(text);
}

function assertCurrent(backend, cache, baseline, cachedBaseline) {
    if (fingerprint(backend) !== baseline || fingerprint(cache) !== cachedBaseline) {
        throw failure('stale', 'World book or cache changed; reload and preview again');
    }
}

async function perform(adapter, input) {
    const { name, baseline, cachedBaseline, next, operation } = input;
    const current = await adapter.read(name); // Always fetch the backend, never trust the cache alone.
    assertCurrent(current, await adapter.cached(name), baseline, cachedBaseline);
    const backup = {
        id: globalThis.crypto?.randomUUID?.() ?? `wb-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`,
        name,
        createdAt: new Date().toISOString(),
        operation,
        data: snapshot(current),
    };
    try {
        const previous = await adapter.getBackups();
        if (!Array.isArray(previous)) throw new Error('Backup storage is not an array');
        const items = [...snapshot(previous), backup].slice(-MAX_BACKUPS);
        await adapter.putBackups(snapshot(items));
        // Read back so a silent/non-persistent storage failure cannot permit a write.
        if (fingerprint(await adapter.getBackups()) !== fingerprint(items)) {
            throw new Error('Local backup persistence verification failed');
        }
    } catch (cause) {
        throw failure('backup_failed', 'Local backup failed; world book was not written', cause);
    }

    // Re-fetch BOTH backend and cache after backup I/O, immediately before writing.
    // There is NO server CAS: another client can still write between this read and
    // write, or after verification. Local queues only serialize this adapter instance,
    // not other tabs/adapters/users; these checks reduce, but cannot eliminate races.
    assertCurrent(await adapter.read(name), await adapter.cached(name), baseline, cachedBaseline);
    try {
        await adapter.write(name, snapshot(next));
    } catch (cause) {
        // Keep the backup even if a failing request may already have reached the server.
        throw failure('write_failed', 'Write failed; local backup retained (server state may be uncertain)', cause);
    }
    try {
        const actual = await adapter.read(name);
        if (fingerprint(actual) !== fingerprint(next)) throw new Error('Backend differs from requested data');
        return { backup: snapshot(backup), data: snapshot(actual) };
    } catch (cause) {
        throw failure('verification_failed', 'Post-write verification failed; local backup retained', cause);
    }
}

/**
 * Save only after matching backend/cache baselines and persisting a local backup.
 * Both sync and async adapter methods are supported. Successful return is
 * { backup, data }; all failures reject (error.code === 'stale' for conflicts).
 * Inputs and adapter outputs must be JSON data, except root cachedBaseline/cache
 * may be undefined. getBackups/putBackups store an oldest-to-newest record array.
 * Retention is 20 records. Even a failed or stale-after-backup attempt retains its
 * backup; callers must never present a rejected transaction as a successful save.
 */
export async function commitWithBackup(adapter, { name, baseline, cachedBaseline, next, operation }) {
    for (const method of ['read', 'cached', 'write', 'getBackups', 'putBackups']) {
        if (typeof adapter?.[method] !== 'function') throw failure('invalid_adapter', `Missing adapter.${method}`);
    }
    if (typeof name !== 'string' || !name.trim() || typeof operation !== 'string' || !operation.trim()) {
        throw failure('invalid_data', 'Nonempty name and operation are required');
    }
    if (baseline === undefined || next === undefined) throw failure('invalid_data', 'Backend baseline and next must be JSON data');
    // Snapshot synchronously, before any await/queue, to resist caller mutation.
    const input = { name, operation, baseline: fingerprint(baseline), cachedBaseline: fingerprint(cachedBaseline), next: snapshot(next) };
    const preceding = queues.get(adapter) ?? Promise.resolve();
    const task = preceding.catch(() => {}).then(() => perform(adapter, input));
    queues.set(adapter, task);
    try {
        return await task;
    } finally {
        if (queues.get(adapter) === task) queues.delete(adapter);
    }
}
