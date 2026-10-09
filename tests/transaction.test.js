import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, commitWithBackup } from '../transaction.js';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const initial = () => ({ entries: { '7': { uid: 7, content: 'before', extensions: { unknown: true } } }, extension: { preserve: [1, null, false] } });
const changed = () => ({ ...initial(), entries: { '7': { uid: 7, content: 'after', extensions: { unknown: true } } } });
function fixture({ cache = initial(), backups = [] } = {}) {
    const state = { backend: initial(), cache: clone(cache), backups: clone(backups), events: [], reads: 0, writes: 0 };
    const adapter = {
        read(name) { state.events.push(`read:${name}`); state.reads++; return clone(state.backend); },
        cached(name) { state.events.push(`cached:${name}`); return clone(state.cache); },
        write(name, data) { state.events.push(`write:${name}`); state.writes++; state.backend = clone(data); state.cache = clone(data); },
        getBackups() { state.events.push('getBackups'); return clone(state.backups); },
        putBackups(items) { state.events.push('putBackups'); state.backups = clone(items); },
    };
    const input = () => ({ name: 'Book', baseline: initial(), cachedBaseline: clone(cache), next: changed(), operation: 'optimize' });
    return { state, adapter, input };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

// Fingerprinting compares JSON structure, not insertion order or a password hash.
test('fingerprint is recursively sorted JSON text', () => {
    assert.equal(fingerprint({ z: [{ b: 2, a: 1 }], a: { y: false, x: null } }), '{"a":{"x":null,"y":false},"z":[{"a":1,"b":2}]}');
    assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
    assert.equal(fingerprint({ 2: 'two', 10: 'ten' }), '{"10":"ten","2":"two"}');
});
test('fingerprint preserves arrays, primitives and escaped strings', () => {
    for (const value of [null, true, false, 42, 0, '', '中文\n"\\', [1, 2], []]) {
        assert.deepEqual(JSON.parse(fingerprint(value)), value);
    }
    assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
    assert.notEqual(fingerprint('1'), fingerprint(1));
    assert.notEqual(fingerprint({ entries: [] }), fingerprint({ entries: {} }));
    assert.equal(fingerprint(undefined), undefined);
    assert.notEqual(fingerprint(undefined), fingerprint(null));
});
test('fingerprint handles null prototypes, __proto__ keys, and shared acyclic values', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe"}');
    assert.deepEqual(JSON.parse(fingerprint(data)), data);
    assert.equal({}.polluted, undefined);
    assert.equal(fingerprint(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
    const shared = { x: 1 };
    assert.equal(fingerprint({ b: shared, a: shared }), '{"a":{"x":1},"b":{"x":1}}');
});
test('fingerprint rejects lossy or executable non-JSON values', () => {
    const cyclic = {}; cyclic.self = cyclic;
    const extraArray = []; extraArray.extra = true;
    const symbolObject = { [Symbol('x')]: true };
    const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { throw new Error('must not execute'); } });
    for (const value of [NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), new Date(), new Map(), cyclic, { x: undefined }, [undefined], new Array(2), extraArray, symbolObject, accessor]) {
        assert.throws(() => fingerprint(value), error => error.code === 'invalid_data');
    }
});

test('successful commit backs up the current backend before writing and verifies', async () => {
    const { state, adapter, input } = fixture();
    const result = await commitWithBackup(adapter, input());
    assert.deepEqual(state.backend, changed());
    assert.deepEqual(result.data, changed());
    assert.equal(state.writes, 1);
    assert.equal(state.reads, 3);
    assert.deepEqual(state.events, ['read:Book', 'cached:Book', 'getBackups', 'putBackups', 'getBackups', 'read:Book', 'cached:Book', 'write:Book', 'read:Book']);
    assert.deepEqual(Object.keys(result.backup).sort(), ['createdAt', 'data', 'id', 'name', 'operation']);
    assert.equal(result.backup.name, 'Book');
    assert.equal(result.backup.operation, 'optimize');
    assert.ok(result.backup.id);
    assert.ok(Number.isFinite(Date.parse(result.backup.createdAt)));
    assert.deepEqual(result.backup.data, initial());
    assert.deepEqual(state.backups, [result.backup]);
    result.backup.data.entries['7'].content = 'mutated result';
    result.data.entries['7'].content = 'mutated result';
    assert.deepEqual(state.backups[0].data, initial());
    assert.deepEqual(state.backend, changed());
});
test('undefined cache baseline is valid', async () => {
    const { adapter, input, state } = fixture({ cache: undefined });
    // A destructuring default would otherwise supply initial(); force true absence.
    state.cache = undefined;
    const request = input(); request.cachedBaseline = undefined;
    await commitWithBackup(adapter, request);
    assert.equal(state.writes, 1);
});
test('key order differences do not make backend or cache stale', async () => {
    const { adapter, input, state } = fixture();
    state.backend = { extension: initial().extension, entries: initial().entries };
    state.cache = { extension: initial().extension, entries: initial().entries };
    await commitWithBackup(adapter, input());
    assert.equal(state.writes, 1);
});
for (const source of ['backend', 'cache']) {
    test(`initial ${source} conflict is stale without backup or write`, async () => {
        const { state, adapter, input } = fixture();
        state[source].entries['7'].content = 'external';
        await rejectsCode(commitWithBackup(adapter, input()), 'stale');
        assert.equal(state.writes, 0);
        assert.deepEqual(state.backups, []);
        assert.ok(!state.events.includes('putBackups'));
    });
    test(`a ${source} change during backup is caught by final recheck`, async () => {
        const { state, adapter, input } = fixture();
        const original = adapter.putBackups;
        adapter.putBackups = items => { original(items); state[source].extension.external = 'new'; };
        await rejectsCode(commitWithBackup(adapter, input()), 'stale');
        assert.equal(state.writes, 0);
        assert.equal(state.backups.length, 1);
        assert.deepEqual(state.backups[0].data, initial());
    });
}
test('absent cache differs from null and from newly populated cache', async () => {
    for (const current of [null, initial()]) {
        const { state, adapter, input } = fixture();
        const request = input(); request.cachedBaseline = undefined; state.cache = current;
        await rejectsCode(commitWithBackup(adapter, request), 'stale');
        assert.equal(state.writes, 0);
    }
});
test('backups contain backend data, not a differing but accepted cache snapshot', async () => {
    const { state, adapter, input } = fixture({ cache: { cacheOnly: true } });
    await commitWithBackup(adapter, input());
    assert.deepEqual(state.backups[0].data, initial());
});
for (const method of ['getBackups', 'putBackups']) {
    test(`${method} storage failure prohibits writing`, async () => {
        const { state, adapter, input } = fixture();
        const cause = new Error('quota/unavailable');
        adapter[method] = () => { throw cause; };
        await assert.rejects(commitWithBackup(adapter, input()), error => error.code === 'backup_failed' && error.cause === cause);
        assert.equal(state.writes, 0);
        assert.deepEqual(state.backend, initial());
    });
}
test('async storage rejection prohibits writing', async () => {
    const { state, adapter, input } = fixture();
    adapter.putBackups = async () => { throw new Error('async quota'); };
    await rejectsCode(commitWithBackup(adapter, input()), 'backup_failed');
    assert.equal(state.writes, 0);
});
test('malformed backup storage is not silently overwritten', async () => {
    for (const stored of [null, {}, 'broken', undefined]) {
        const { state, adapter, input } = fixture();
        adapter.getBackups = () => stored;
        await rejectsCode(commitWithBackup(adapter, input()), 'backup_failed');
        assert.equal(state.writes, 0);
        assert.ok(!state.events.includes('putBackups'));
    }
});
test('silent backup persistence failure and readback failure prohibit writing', async () => {
    for (const mode of ['silent', 'readback']) {
        const { state, adapter, input } = fixture();
        if (mode === 'silent') adapter.putBackups = () => {};
        else {
            const get = adapter.getBackups; let calls = 0;
            adapter.getBackups = () => { if (++calls === 2) throw new Error('readback unavailable'); return get(); };
        }
        await rejectsCode(commitWithBackup(adapter, input()), 'backup_failed');
        assert.equal(state.writes, 0);
    }
});
test('retains newest 20 backups, preserving prior record structure', async () => {
    const backups = Array.from({ length: 25 }, (_, index) => ({ id: `old-${index}`, name: 'old', createdAt: 'old-time', operation: 'save', data: { index } }));
    const { state, adapter, input } = fixture({ backups });
    await commitWithBackup(adapter, input());
    assert.equal(state.backups.length, 20);
    assert.deepEqual(state.backups.slice(0, -1), backups.slice(-19));
    assert.deepEqual(state.backups.at(-1).data, initial());
    assert.equal(backups.length, 25);
});
test('write rejection retains backup and never reports success', async () => {
    const { state, adapter, input } = fixture();
    const cause = new Error('server unavailable');
    adapter.write = async () => { state.writes++; throw cause; };
    await assert.rejects(commitWithBackup(adapter, input()), error => error.code === 'write_failed' && error.cause === cause);
    assert.equal(state.backups.length, 1);
    assert.deepEqual(state.backups[0].data, initial());
    assert.equal(state.reads, 2);
});
test('a request that mutates backend then rejects is still a write failure', async () => {
    const { state, adapter, input } = fixture();
    const write = adapter.write;
    adapter.write = async (...args) => { write(...args); throw new Error('response lost'); };
    await rejectsCode(commitWithBackup(adapter, input()), 'write_failed');
    assert.deepEqual(state.backend, changed());
    assert.deepEqual(state.backups[0].data, initial());
});
test('post-write mismatch is an error even when write resolved', async () => {
    const { state, adapter, input } = fixture();
    adapter.write = () => { state.writes++; };
    await rejectsCode(commitWithBackup(adapter, input()), 'verification_failed');
    assert.equal(state.writes, 1);
    assert.equal(state.backups.length, 1);
});
test('post-write read failure retains backup', async () => {
    const { state, adapter, input } = fixture();
    const read = adapter.read;
    adapter.read = name => { if (state.writes) throw new Error('read unavailable'); return read(name); };
    await rejectsCode(commitWithBackup(adapter, input()), 'verification_failed');
    assert.equal(state.backups.length, 1);
});
test('read failures before backup and before write never write', async () => {
    for (const failingRead of [1, 2]) {
        const { state, adapter, input } = fixture();
        const read = adapter.read; let calls = 0;
        adapter.read = name => { if (++calls === failingRead) throw new Error('read unavailable'); return read(name); };
        await assert.rejects(commitWithBackup(adapter, input()), /read unavailable/);
        assert.equal(state.writes, 0);
        assert.equal(state.backups.length, failingRead - 1);
    }
});
test('cache read failure never writes', async () => {
    const { state, adapter, input } = fixture();
    adapter.cached = () => { throw new Error('cache unavailable'); };
    await assert.rejects(commitWithBackup(adapter, input()), /cache unavailable/);
    assert.equal(state.writes, 0);
});
test('restore uses same transaction and backs up the data it replaces', async () => {
    const { state, adapter, input } = fixture();
    await commitWithBackup(adapter, input());
    const savedBackup = clone(state.backups[0]);
    await commitWithBackup(adapter, { name: 'Book', baseline: changed(), cachedBaseline: changed(), next: savedBackup.data, operation: 'restore' });
    assert.deepEqual(state.backend, initial());
    assert.equal(state.backups.length, 2);
    assert.deepEqual(state.backups[1].data, changed());
    assert.equal(state.backups[1].operation, 'restore');
    assert.notEqual(state.backups[0].id, state.backups[1].id);
});
test('concurrent same-adapter saves serialize; stale second save cannot clobber first', async () => {
    const { state, adapter, input } = fixture();
    const second = input(); second.next.entries['7'].content = 'second';
    const outcomes = await Promise.allSettled([commitWithBackup(adapter, input()), commitWithBackup(adapter, second)]);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[1].reason.code, 'stale');
    assert.equal(state.writes, 1);
    assert.equal(state.backups.length, 1);
    assert.deepEqual(state.backend, changed());
});
test('failed queued transaction does not poison subsequent saves', async () => {
    const { state, adapter, input } = fixture();
    const invalid = input(); invalid.baseline = { stale: true };
    const outcomes = await Promise.allSettled([commitWithBackup(adapter, invalid), commitWithBackup(adapter, input())]);
    assert.equal(outcomes[0].reason.code, 'stale');
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.equal(state.writes, 1);
});
test('snapshots inputs before awaiting and isolates write argument mutation', async () => {
    const { state, adapter, input } = fixture();
    const request = input();
    const promise = commitWithBackup(adapter, request);
    request.baseline.entries['7'].content = 'mutated';
    request.cachedBaseline.entries['7'].content = 'mutated';
    request.next.entries['7'].content = 'mutated';
    const write = adapter.write;
    adapter.write = (name, data) => { write(name, data); data.extension.preserve.push('adapter mutation'); };
    const result = await promise;
    assert.deepEqual(result.data, changed());
    assert.deepEqual(state.backend, changed());
});
test('all asynchronous adapter methods work', async () => {
    const { state, adapter, input } = fixture();
    for (const key of Object.keys(adapter)) { const method = adapter[key]; adapter[key] = async (...args) => method(...args); }
    await commitWithBackup(adapter, input());
    assert.equal(state.writes, 1);
});
test('invalid arguments/adapters reject before side effects', async () => {
    for (const patch of [{ name: '' }, { name: ' ' }, { operation: '' }, { operation: null }, { baseline: undefined }, { next: undefined }, { next: { lossy: undefined } }]) {
        const { state, adapter, input } = fixture();
        await rejectsCode(commitWithBackup(adapter, { ...input(), ...patch }), 'invalid_data');
        assert.deepEqual(state.events, []);
    }
    for (const method of ['read', 'cached', 'write', 'getBackups', 'putBackups']) {
        const { state, adapter, input } = fixture(); delete adapter[method];
        await rejectsCode(commitWithBackup(adapter, input()), 'invalid_adapter');
        assert.deepEqual(state.events, []);
    }
});
test('unknown nested fields survive both backup and commit', async () => {
    const { state, adapter, input } = fixture();
    const request = input();
    request.next.entries['7'].extensions.vendor = { unicode: '未知', flags: [false, null], nested: { b: {}, a: [] } };
    const result = await commitWithBackup(adapter, request);
    assert.deepEqual(result.data, request.next);
    assert.deepEqual(state.backups[0].data, request.baseline);
});
test('documented lack of server CAS leaves a read/write race', async () => {
    const { state, adapter, input } = fixture();
    const write = adapter.write;
    adapter.write = (name, data) => {
        // Simulate an unrelated server writer AFTER the last read, BEFORE edit.
        state.backend = { externalChange: 'cannot be caught by client-side checks' };
        write(name, data);
    };
    await commitWithBackup(adapter, input());
    // This demonstrates a limitation, not a claim of cross-client atomicity.
    assert.deepEqual(state.backend, changed());
    assert.deepEqual(state.backups[0].data, initial());
});
