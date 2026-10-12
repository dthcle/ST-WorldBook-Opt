import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactCapture, chatKey } from '../exact-capture.js';
import { replaySnapshot, useReplayChat, useRecordCopies } from '../request-snapshot.js';

const ENDPOINT = '/api/backends/chat-completions/generate';
const AFTER_DATA = 'generate_after_data';
const STAMP = '2026-01-02T03:04:05.000Z';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const history = () => [
    { name: 'Character', is_user: false, mes: 'Greeting', extra: { marker: 'original-greeting' } },
    { name: 'User', is_user: true, mes: 'Last real input', extra: { marker: 'original-user' } },
    { name: 'Character', is_user: false, mes: 'Latest assistant reply', extra: { marker: 'original-reply' } },
];
const promptFor = chat => chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes }));

// Never patch globalThis or call native fetch. Every test has its own fake host,
// context snapshots, event bus, generation state, and transport acknowledgment.
function fixture(t, options = {}) {
    const listeners = new Map();
    const eventSource = {
        on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
        removeListener(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter(value => value !== fn)); },
        async emit(event, ...args) {
            for (const fn of [...(listeners.get(event) ?? [])]) await fn(...args);
        },
        listenerCount(event) { return (listeners.get(event) ?? []).length; },
    };
    const state = { characterId: 0, groupId: null, chatId: 'chat-1', mainApi: 'openai', chat: history(), generating: false, ...options.state };
    const stats = { dryRuns: 0, ordinaryGenerates: 0, userSends: 0, inputReads: 0, attachmentReads: 0, documentReads: 0,
        stops: 0, contexts: [], data: null, cleaned: false, error: null, transport: [] };
    const started = deferred(), cleanupStarted = deferred(), finished = deferred();
    const host = {
        location: { origin: 'https://st.invalid' },
        document: { getElementById() { stats.documentReads++; throw new Error('composer DOM must not be read'); } },
        async fetch(input, init) {
            stats.transport.push({ input, init });
            return options.transport ? options.transport(input, init) : { ok: true, status: 200 };
        },
    };
    const originalFetch = host.fetch;
    const getContext = () => ({
        ...state, name1: 'User', eventSource, eventTypes: { GENERATE_AFTER_DATA: AFTER_DATA },
        getChatCompletionModel: () => 'simulation-model',
        chatCompletionSettings: { chat_completion_source: 'custom' },
        generate() { stats.ordinaryGenerates++; throw new Error('ordinary Generate fallback forbidden'); },
        sendMessageAsUser() { stats.userSends++; throw new Error('persistent user send forbidden'); },
        ...options.context,
    });
    const helpers = { state, stats, host, eventSource, getContext };
    const dryRunGenerate = async ctx => {
        stats.dryRuns++;
        stats.contexts.push(ctx);
        state.generating = true;
        started.resolve(ctx);
        try {
            if (options.beforeData) await options.beforeData.promise;
            if (options.run) await options.run(ctx, helpers);
            else {
                const data = { prompt: promptFor(ctx.chat), privateCredential: 'DO_NOT_RETAIN' };
                stats.data = data;
                // Register after simulate() installed its capture listener. Emit awaits
                // late plugins before returning; cloning in the first listener is wrong.
                let lateListener;
                if (options.lateListener) {
                    lateListener = async (value, dryRun) => {
                        await Promise.resolve();
                        await options.lateListener(value, dryRun, ctx, helpers);
                    };
                    eventSource.on(AFTER_DATA, lateListener);
                }
                try { await eventSource.emit(AFTER_DATA, data, true); }
                finally { if (lateListener) eventSource.removeListener(AFTER_DATA, lateListener); }
            }
        } catch (error) {
            stats.error = error;
            throw error;
        } finally {
            cleanupStarted.resolve();
            if (options.cleanupGate) await options.cleanupGate.promise;
            state.generating = false;
            stats.cleaned = true;
            finished.resolve();
        }
    };
    const config = {
        host, getContext, dryRunGenerate,
        isGenerating: () => state.generating,
        stopGeneration: () => { stats.stops++; if (options.stopThrows) throw new Error('broken stop'); },
        timeoutMs: options.timeoutMs ?? 2000, now: () => STAMP,
        getInput: () => { stats.inputReads++; return options.input ?? 'Unsent draft'; },
        hasAttachment: () => { stats.attachmentReads++; return options.attachment ?? false; },
        getPromptError: () => options.promptError ?? null,
        ...options.config,
    };
    const runtime = createExactCapture(config);
    t.after(() => runtime.destroy());
    return { ...helpers, runtime, config, originalFetch, started, cleanupStarted, finished };
}

function realPost(f, body = { model: 'real-model', chat_completion_source: 'openai', messages: [{ role: 'user', content: 'Actual transport input' }] }, init = {}) {
    return f.host.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), ...init });
}
async function settle(f) { await f.finished.promise; await tick(); }
function assertOriginals(chat, originals) {
    assert.equal(chat.length, originals.length);
    originals.forEach((message, index) => assert.equal(chat[index], message, `message ${index} must retain original object identity`));
}
function assertNoComposerRead(f) {
    assert.equal(f.stats.inputReads, 0);
    assert.equal(f.stats.attachmentReads, 0);
    assert.equal(f.stats.documentReads, 0);
    assert.equal(f.stats.ordinaryGenerates, 0);
    assert.equal(f.stats.userSends, 0);
}
function assertClean(f, chat, originals) {
    assert.equal(f.runtime.isBusy(), false);
    assert.equal(f.eventSource.listenerCount(AFTER_DATA), 0);
    assertOriginals(chat, originals);
    assertNoComposerRead(f);
}

// request-snapshot.js: cloning and identity restoration without ST core imports.
test('replaySnapshot ends at latest non-system user, excludes subsequent assistants, and deep-clones', () => {
    const chat = history();
    chat.push({ is_user: true, is_system: true, mes: 'System pseudo-user' }, { is_user: false, mes: 'Later assistant' });
    const snapshot = replaySnapshot({ chat });
    assert.deepEqual(snapshot.chat, chat.slice(0, 2));
    assert.equal(snapshot.userText, 'Last real input');
    assert.notEqual(snapshot.chat[0], chat[0]);
    snapshot.chat[1].extra.marker = 'mutated snapshot';
    assert.equal(chat[1].extra.marker, 'original-user');
    chat[1].mes = 'edited original';
    assert.equal(snapshot.userText, 'Last real input');
});

for (const [label, ctx] of [
    ['missing context', undefined], ['missing chat', {}], ['non-array chat', { chat: {} }],
    ['empty chat', { chat: [] }], ['assistants only', { chat: [{ is_user: false, mes: 'hello' }] }],
    ['system users only', { chat: [{ is_user: true, is_system: true, mes: 'system' }] }],
    ['uncloneable prefix', { chat: [{ is_user: true, mes: 'hi', pluginFunction() {} }] }],
]) test(`replaySnapshot safely returns null for ${label}`, () => assert.equal(replaySnapshot(ctx), null));

test('replaySnapshot handles index-zero user and absent message text', () => {
    assert.deepEqual(replaySnapshot({ chat: [{ is_user: true }, { is_user: false, mes: 'reply' }] }),
        { chat: [{ is_user: true }], userText: '' });
});

test('useReplayChat changes only array contents, clones replay objects, and restores originals once', () => {
    const chat = history(), originals = chat.slice(), snapshot = replaySnapshot({ chat });
    const restore = useReplayChat(chat, snapshot);
    assert.deepEqual(chat, snapshot.chat);
    assert.notEqual(chat[0], snapshot.chat[0]);
    assert.notEqual(chat[0], originals[0]);
    chat[0].extra.marker = 'plugin mutation';
    chat.push({ is_user: true, mes: 'temporary append' });
    restore();
    assertOriginals(chat, originals);
    assert.equal(originals[0].extra.marker, 'original-greeting');
    assert.equal(snapshot.chat[0].extra.marker, 'original-greeting');
    const later = { is_user: false, mes: 'added after restoration' };
    chat.push(later);
    restore();
    assert.equal(chat.at(-1), later, 'restoration closure must be idempotent');
});

for (const [label, chat, snapshot] of [
    ['invalid target', {}, { chat: [] }], ['missing snapshot', [], null], ['invalid snapshot history', [], { chat: {} }],
]) test(`useReplayChat rejects ${label} before modifying anything`, () => {
    const before = structuredClone(chat);
    assert.throws(() => useReplayChat(chat, snapshot), /缺少可重放/);
    assert.deepEqual(chat, before);
});

test('useReplayChat clone failure leaves original array and objects untouched', () => {
    const chat = history(), originals = chat.slice();
    assert.throws(() => useReplayChat(chat, { chat: [{ is_user: true, bad() {} }] }), /clone/i);
    assertOriginals(chat, originals);
});

// Native dry-run output and the empty/draft full-current-history contracts.
test('empty simulation uses complete current chat clones, appends no input, and awaits late event mutations', async t => {
    const cleanupGate = deferred();
    const f = fixture(t, { cleanupGate, lateListener: async (data, dryRun, ctx) => {
        assert.equal(dryRun, true);
        data.prompt[0].content = 'Final awaited world info';
        data.prompt.push({ role: 'system', content: 'Late plugin suffix' });
        ctx.chat[0].mes = 'Dry-run greeting substitution';
        ctx.chat[0].extra.marker = 'Changed on clone only';
    } });
    const chat = f.state.chat, originals = chat.slice(), originalValues = structuredClone(chat);
    let resolved = false;
    const simulation = f.runtime.simulate({ mode: 'empty' }).then(result => { resolved = true; return result; });
    try {
        const ctx = await f.started.promise;
        assert.equal(ctx.chat, chat, 'keep the exported chat array binding');
        assert.equal(ctx.chat.length, originals.length, 'no empty/input user message appended');
        originals.forEach((message, i) => assert.notEqual(ctx.chat[i], message));
        await f.cleanupStarted.promise;
        assert.equal(resolved, false, 'must await generation cleanup, not just the event');
        assert.equal(f.runtime.isBusy(), true);
        assert.equal(chat[0].mes, 'Dry-run greeting substitution');
        cleanupGate.resolve();
        const result = await simulation;
        assert.deepEqual(result.current.messages, [
            { role: 'assistant', content: 'Final awaited world info' },
            { role: 'user', content: 'Last real input' },
            { role: 'assistant', content: 'Latest assistant reply' },
            { role: 'system', content: 'Late plugin suffix' },
        ]);
        assert.equal(result.current.kind, 'simulation');
        assert.equal(result.current.mode, 'empty');
        assert.equal(result.current.model, 'simulation-model');
        assert.equal(result.current.source, 'custom');
        assert.equal(result.current.key, chatKey(f.getContext()));
        assert.equal(result.current.capturedAt, STAMP);
        assert.equal(result.previous, null);
        assert.equal(result.wroteMessage, false);
        assert.equal(f.runtime.wroteChatMessage(), false);
        assert.ok(result.warnings.some(value => /dry-run/.test(value)));
        assert.ok(result.warnings.some(value => /SETTINGS_READY/.test(value)));
        assert.equal(JSON.stringify(result).includes('DO_NOT_RETAIN'), false);
        f.stats.data.prompt[0].content = 'Mutation after completion';
        assert.equal(result.current.messages[0].content, 'Final awaited world info');
        assert.deepEqual(chat, originalValues);
        assertClean(f, chat, originals);
        assert.equal(f.stats.transport.length, 0);
        assert.equal(f.stats.stops, 0);
    } finally { cleanupGate.resolve(); }
});

test('default simulation mode is empty and works with an empty chat without appending a user', async t => {
    const f = fixture(t, { state: { chat: [] }, run: async (ctx, { eventSource }) => {
        assert.deepEqual(ctx.chat, []);
        await eventSource.emit(AFTER_DATA, { prompt: [{ role: 'system', content: 'Character world info' }] }, true);
    } });
    const result = await f.runtime.simulate();
    assert.equal(result.current.mode, 'empty');
    assert.deepEqual(f.state.chat, []);
    assertNoComposerRead(f);
});

for (const value of ['', 'plain unsent text', ' /send dangerous', '/upload file', 'text with pending attachment'])
    test(`simulation never reads composer or attachments for ${JSON.stringify(value)}`, async t => {
        const f = fixture(t, { config: {
            getInput: () => { throw new Error(`must not inspect ${value}`); },
            hasAttachment: () => { throw new Error('pending attachment inspection forbidden'); },
        } });
        await f.runtime.simulate({ mode: 'empty' });
        assert.equal(f.stats.documentReads, 0);
        assert.equal(f.stats.ordinaryGenerates, 0);
        assert.equal(f.stats.transport.length, 0);
    });

test('draft reads composer once, appends only a plain cloned user to full current chat, and leaves composer/originals unchanged', async t => {
    const composer = { value: '  {{user}} raw draft  ' };
    let reads = 0, writes = 0;
    const f = fixture(t, { config: { getInput: () => { reads++; return composer.value; } },
        run: async (ctx, { eventSource }) => {
            assert.equal(ctx.chat, chat, 'keep the original exported array binding');
            assert.equal(ctx.chat.length, originals.length + 1);
            originals.forEach((message, index) => assert.notEqual(ctx.chat[index], message));
            assert.deepEqual(ctx.chat.slice(0, -1), originalValues, 'include latest assistant, not a prior-send prefix');
            const draft = ctx.chat.at(-1);
            assert.deepEqual(draft, { name: 'User', is_user: true, is_system: false, mes: composer.value, send_date: STAMP, extra: {} });
            await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
            ctx.chat[0].extra.marker = 'temporary clone mutation';
            draft.mes = 'temporary draft mutation';
        } });
    Object.defineProperty(composer, 'value', { get: () => '  {{user}} raw draft  ', set() { writes++; throw new Error('composer mutation forbidden'); } });
    const chat = f.state.chat, originals = chat.slice(), originalValues = structuredClone(chat);
    const result = await f.runtime.simulate({ mode: 'draft' });
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.equal(composer.value, '  {{user}} raw draft  ');
    assert.equal(f.stats.attachmentReads, 1);
    assert.equal(f.stats.documentReads, 0);
    assert.equal(f.stats.ordinaryGenerates, 0);
    assert.equal(f.stats.userSends, 0);
    assert.equal(result.current.mode, 'draft');
    assert.deepEqual(result.current.messages, [...promptFor(originalValues), { role: 'user', content: composer.value }]);
    assert.equal(result.previous, null);
    assert.equal(result.wroteMessage, false);
    assert.ok(result.warnings.some(value => /正则\/宏.*近似/.test(value)));
    assert.equal(result.warnings.some(value => /重放/.test(value)), false);
    assertOriginals(chat, originals);
    assert.deepEqual(chat, originalValues);
    assert.equal(f.runtime.isBusy(), false);
    assert.equal(f.eventSource.listenerCount(AFTER_DATA), 0);
    assert.equal(f.stats.transport.length, 0);
});

for (const input of ['', ' /send dangerous', '\n\t/upload file'])
    test(`draft ${JSON.stringify(input)} ${input ? 'rejects slash commands' : 'is a temporary empty plain user message'}`, async t => {
        const f = fixture(t, { input });
        const chat = f.state.chat, originals = chat.slice();
        if (input) {
            await assert.rejects(f.runtime.simulate({ mode: 'draft' }), /斜杠命令/);
            assert.equal(f.stats.attachmentReads, 0);
            assert.equal(f.stats.dryRuns, 0);
        } else {
            const result = await f.runtime.simulate({ mode: 'draft' });
            assert.deepEqual(result.current.messages.at(-1), { role: 'user', content: '' });
            assert.equal(f.stats.attachmentReads, 1);
        }
        assert.equal(f.stats.inputReads, 1);
        assertOriginals(chat, originals);
        assert.equal(f.stats.transport.length, 0);
        assert.equal(f.stats.ordinaryGenerates, 0);
        assert.equal(f.stats.userSends, 0);
    });

test('draft rejects pending attachments before replacing history or running generation', async t => {
    const f = fixture(t, { attachment: true });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate({ mode: 'draft' }), /附件/);
    assert.equal(f.stats.inputReads, 1);
    assert.equal(f.stats.attachmentReads, 1);
    assert.equal(f.stats.dryRuns, 0);
    assert.equal(f.stats.transport.length, 0);
    assertOriginals(chat, originals);
});

for (const mode of ['replay', 'manual'])
    test(`obsolete ${mode} mode rejects and manual simulation-base API is absent`, async t => {
        const f = fixture(t);
        assert.equal(f.runtime.getSimulationBase, undefined);
        assert.equal(f.runtime.setSimulationBase, undefined);
        await assert.rejects(f.runtime.simulate({ mode }), /未知模拟方式/);
        assertNoComposerRead(f);
        assert.equal(f.stats.dryRuns, 0);
    });

test('N-1 actual BASE compares to N upcoming full history, and repeated empty/draft never advances BASE or pair', async t => {
    const f = fixture(t);
    await realPost(f, { model: 'N-1', messages: [{ role: 'user', content: 'N-1 actual input' }] });
    const baseline = f.runtime.getLast(), pair = f.runtime.getLastPair();
    assert.deepEqual(pair, { previous: null, current: baseline });
    f.state.chat[1].mes = 'Edited current user history';
    f.state.chat.push({ is_user: false, mes: 'New assistant after N-1 actual request' });
    const chat = f.state.chat, originals = chat.slice();
    for (let i = 0; i < 3; i++) {
        const result = await f.runtime.simulate();
        assert.deepEqual(result.previous, baseline);
        assert.deepEqual(result.current.messages, promptFor(chat));
        assert.equal(result.current.messages.at(-1).content, 'New assistant after N-1 actual request');
        assert.deepEqual(f.runtime.getLast(), baseline);
        assert.deepEqual(f.runtime.getLastPair(), pair);
        assertClean(f, chat, originals);
        result.previous.messages[0].content = 'Caller mutation does not replace BASE';
    }
    const draft = await f.runtime.simulate({ mode: 'draft' });
    assert.deepEqual(draft.previous, baseline);
    assert.equal(draft.current.messages.at(-1).content, 'Unsent draft');
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.deepEqual(f.runtime.getLastPair(), pair);
    await realPost(f, { model: 'N', messages: draft.current.messages });
    const current = f.runtime.getLast();
    assert.deepEqual(f.runtime.getLastPair(), { previous: baseline, current });
    const next = await f.runtime.simulate();
    assert.deepEqual(next.previous, current, 'N actual becomes BASE for N+1 upcoming');
    assert.equal(f.stats.transport.length, 2, 'only explicit actual requests delegate');
});

test('acknowledged real request without any user history remains an actual BASE for empty upcoming', async t => {
    const f = fixture(t, { state: { chat: [{ is_user: false, mes: 'Greeting only' }] } });
    await realPost(f);
    const baseline = f.runtime.getLast();
    const result = await f.runtime.simulate();
    assert.deepEqual(result.previous, baseline);
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: baseline });
});

// Baseline provenance, acknowledgment, selection, isolation and immutability.
test('dry-run event and successful simulations never create or overwrite an actual baseline', async t => {
    const f = fixture(t);
    await f.eventSource.emit(AFTER_DATA, { prompt: [{ role: 'user', content: 'Event without transport' }] }, false);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    for (let i = 0; i < 3; i++) {
        const result = await f.runtime.simulate();
        assert.equal(result.previous, null, 'no invented BASE from previous dry-run');
        assert.equal(f.runtime.getLast(), null);
        assert.equal(f.runtime.getLastPair(), null);
    }
    await realPost(f);
    const baseline = f.runtime.getLast();
    const result = await f.runtime.simulate();
    assert.deepEqual(result.previous, baseline);
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.equal(f.stats.transport.length, 1);
});

test('actual baseline overwrite occurs only after successful transport acknowledgment, not event or dispatch', async t => {
    const response = deferred(), delegated = deferred();
    let delay = false;
    const f = fixture(t, { transport: async () => {
        if (delay) { delegated.resolve(); return response.promise; }
        return { ok: true, status: 200 };
    } });
    await realPost(f);
    const initial = f.runtime.getLast();
    delay = true;
    const sending = realPost(f, { model: 'new-actual-model', messages: [{ role: 'user', content: 'New actual body' }] });
    await delegated.promise;
    await f.eventSource.emit(AFTER_DATA, { prompt: [{ role: 'user', content: 'Not a send' }] }, false);
    assert.deepEqual(f.runtime.getLast(), initial);
    response.resolve({ ok: true, status: 202 });
    await sending;
    assert.equal(f.runtime.getLast().model, 'new-actual-model');
    assert.equal(f.runtime.getLast().kind, 'actual');
    assert.match(f.runtime.getLast().status, /HTTP 202/);
    assert.deepEqual(f.runtime.getLastPair(), { previous: initial, current: f.runtime.getLast() });
});

for (const [label, transport] of [
    ['unsuccessful HTTP response', async () => ({ ok: false, status: 500 })],
    ['transport exception', async () => { throw new Error('fake network failure'); }],
]) test(`${label} does not overwrite an acknowledged actual baseline or pair`, async t => {
    let fail = false;
    const f = fixture(t, { transport: (...args) => fail ? transport(...args) : { ok: true, status: 200 } });
    await realPost(f);
    const baseline = f.runtime.getLast();
    fail = true;
    f.state.chat[1].mes = 'Failed transport history';
    await realPost(f, { model: 'failed-model', messages: [] }).catch(error => assert.match(error.message, /fake network failure/));
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: baseline });
    const upcoming = await f.runtime.simulate();
    assert.deepEqual(upcoming.previous, baseline);
    assert.deepEqual(upcoming.current.messages, promptFor(f.state.chat));
});

test('invalid, auxiliary, and aborted actual requests never replace actual baseline or pair', async t => {
    const f = fixture(t);
    await realPost(f);
    const baseline = f.runtime.getLast();
    f.state.chat[1].mes = 'Should not replace actual BASE';
    for (const type of ['quiet', 'impersonate']) await realPost(f, { type, messages: [] });
    const controller = new AbortController(); controller.abort();
    await realPost(f, undefined, { signal: controller.signal });
    await f.host.fetch(ENDPOINT, { method: 'POST', body: '{invalid' });
    await realPost(f, { model: 'missing-messages' });
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: baseline });
    const upcoming = await f.runtime.simulate();
    assert.deepEqual(upcoming.previous, baseline);
    assert.deepEqual(upcoming.current.messages, promptFor(f.state.chat));
});

test('getLastPair defensively clones exactly the last two consecutive acknowledged actual packets', async t => {
    const f = fixture(t);
    assert.equal(f.runtime.getLastPair(), null);
    await realPost(f, { model: 'first', messages: [{ role: 'user', content: 'first actual' }], tools: [{ function: { name: 'first-tool' } }] });
    const first = f.runtime.getLast();
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: first });
    await realPost(f, { model: 'second', messages: [{ role: 'user', content: 'second actual' }] });
    const second = f.runtime.getLast();
    const expected = structuredClone({ previous: first, current: second });
    assert.deepEqual(f.runtime.getLastPair(), expected);
    const pair = f.runtime.getLastPair();
    pair.previous.messages[0].content = 'mutated getter previous';
    pair.previous.tools[0].function.name = 'mutated tool';
    pair.current.messages[0].content = 'mutated getter current';
    second.messages[0].content = 'mutated getLast';
    assert.deepEqual(f.runtime.getLastPair(), expected);
    await f.runtime.simulate();
    assert.deepEqual(f.runtime.getLastPair(), expected);
    await realPost(f, { model: 'third', messages: [{ role: 'user', content: 'third actual' }] });
    assert.equal(f.runtime.getLastPair().previous.model, 'second');
    assert.equal(f.runtime.getLastPair().current.model, 'third');
});

test('BASE/pair are chat-scoped, never bridge a different actual chat, and clear removes both', async t => {
    const f = fixture(t);
    await realPost(f, { model: 'chat-1-first', messages: [] });
    await realPost(f, { model: 'chat-1-second', messages: [] });
    const oldPair = f.runtime.getLastPair();
    f.state.chatId = 'other-chat';
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    assert.equal((await f.runtime.simulate()).previous, null);
    f.state.chatId = 'chat-1';
    assert.deepEqual(f.runtime.getLastPair(), oldPair);
    f.state.chatId = 'other-chat';
    await realPost(f, { model: 'other-chat-first', messages: [] });
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: f.runtime.getLast() });
    f.state.chatId = 'chat-1';
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    await realPost(f, { model: 'chat-1-returned', messages: [] });
    assert.equal(f.runtime.getLastPair().previous, null, 'no stale non-consecutive packet restored from chat-1');
    f.runtime.clear();
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    assert.equal((await f.runtime.simulate()).previous, null);
});

test('out-of-order responses fill latest acknowledged N-1/N pair without regressing BASE; clear invalidates older and newer pending acks', async t => {
    const responses = Array.from({ length: 6 }, deferred);
    let index = 0, delayed = false;
    const f = fixture(t, { transport: () => delayed ? responses[index++].promise : { ok: true, status: 200 } });
    await realPost(f, { model: 'acknowledged BASE', messages: [] });
    const base = f.runtime.getLast();
    delayed = true;
    const oldest = realPost(f, { model: 'oldest pending N-2', messages: [] });
    const older = realPost(f, { model: 'older pending N-1', messages: [] });
    const newer = realPost(f, { model: 'newest pending N', messages: [] });
    await tick();
    responses[2].resolve({ ok: true, status: 200 });
    await newer;
    const newest = f.runtime.getLast();
    assert.deepEqual(f.runtime.getLastPair(), { previous: base, current: newest });
    responses[1].resolve({ ok: true, status: 202 });
    await older;
    const newestPair = f.runtime.getLastPair();
    assert.equal(newestPair.previous.model, 'older pending N-1');
    assert.match(newestPair.previous.status, /HTTP 202/);
    assert.deepEqual(newestPair.current, newest);
    assert.deepEqual(f.runtime.getLast(), newest, 'late N-1 acknowledgment must not change BASE');
    responses[0].resolve({ ok: true, status: 200 });
    await oldest;
    assert.deepEqual(f.runtime.getLastPair(), newestPair, 'even older ack cannot displace N-1');
    const preclearOlder = realPost(f, { model: 'cleared older pending', messages: [] });
    const preclearNewer = realPost(f, { model: 'cleared newer pending', messages: [] });
    await tick();
    f.runtime.clear();
    const afterClear = realPost(f, { model: 'fresh after clear', messages: [] });
    await tick();
    responses[5].resolve({ ok: true, status: 200 });
    await afterClear;
    const freshPair = f.runtime.getLastPair();
    assert.equal(freshPair.previous, null);
    responses[4].resolve({ ok: true, status: 200 });
    responses[3].resolve({ ok: true, status: 200 });
    await Promise.all([preclearOlder, preclearNewer]);
    assert.deepEqual(f.runtime.getLastPair(), freshPair, 'cleared candidates cannot fill fresh predecessor either');
    assert.deepEqual(f.runtime.getLast(), freshPair.current);
});

for (const succeeds of [false, true])
    test(`out-of-order first two actual responses ${succeeds ? 'fill an acknowledged predecessor' : 'do not invent a failed predecessor'}`, async t => {
        const responses = [deferred(), deferred()];
        let index = 0;
        const f = fixture(t, { transport: () => responses[index++].promise });
        const older = realPost(f, { model: 'older', messages: [] });
        const newer = realPost(f, { model: 'newer', messages: [] });
        await tick();
        responses[1].resolve({ ok: true, status: 200 });
        await newer;
        const current = f.runtime.getLast();
        assert.deepEqual(f.runtime.getLastPair(), { previous: null, current });
        responses[0].resolve({ ok: succeeds, status: succeeds ? 200 : 500 });
        await older;
        assert.deepEqual(f.runtime.getLast(), current);
        assert.equal(f.runtime.getLastPair().previous?.model ?? null, succeeds ? 'older' : null);
        assert.deepEqual(f.runtime.getLastPair().current, current);
    });

test('asynchronous Request body read freezes chat attribution and cannot bridge a new-chat pair', async t => {
    const bodyGate = deferred();
    const f = fixture(t);
    await realPost(f, { model: 'initial old-chat', messages: [] });
    const stream = new ReadableStream({ async start(controller) {
        await bodyGate.promise;
        controller.enqueue(new TextEncoder().encode('{"model":"late old-chat","messages":[]}'));
        controller.close();
    } });
    const old = f.host.fetch(new Request(`${f.host.location.origin}${ENDPOINT}`, { method: 'POST', body: stream, duplex: 'half' }));
    await tick();
    f.state.chatId = 'new-chat';
    await realPost(f, { model: 'new-chat acknowledged', messages: [] });
    const pair = f.runtime.getLastPair();
    assert.equal(pair.previous, null);
    bodyGate.resolve();
    await old;
    assert.deepEqual(f.runtime.getLastPair(), pair);
    assert.deepEqual(f.runtime.getLast(), pair.current);
});

// Verified dry-run interface and output validation. No normal-generate fallback.
for (const [label, options] of [
    ['missing dryRunGenerate', { config: { dryRunGenerate: undefined } }],
    ['non-function dryRunGenerate', { config: { dryRunGenerate: true } }],
    ['missing event type', { context: { eventTypes: {} } }],
    ['missing eventSource', { context: { eventSource: null } }],
    ['missing on', { context: { eventSource: { removeListener() {} } } }],
    ['missing removeListener', { context: { eventSource: { on() {} } } }],
]) test(`${label} fails closed before replacing history or using ordinary Generate`, async t => {
    const f = fixture(t, options);
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /缺少已验证的 dry-run 接口.*不会退回普通发送/);
    assert.equal(f.stats.dryRuns, 0);
    assert.equal(f.stats.transport.length, 0);
    assertClean(f, chat, originals);
});

for (const [label, state, mode, pattern] of [
    ['busy host', { generating: true }, 'empty', /正在生成/],
    ['unsupported API', { mainApi: 'textgenerationwebui' }, 'empty', /Chat Completion/],
    ['group chat', { groupId: 'group' }, 'empty', /群聊/],
    ['no character', { characterId: null }, 'empty', /打开单人角色聊天/],
    ['missing chat', { chat: null }, 'empty', /打开单人角色聊天/],
    ['unknown mode', {}, 'send', /未知模拟方式/],
]) test(`simulate rejects ${label} before generation or network`, async t => {
    const f = fixture(t, { state });
    await assert.rejects(f.runtime.simulate({ mode }), pattern);
    assert.equal(f.stats.dryRuns, 0);
    assert.equal(f.stats.transport.length, 0);
    assertNoComposerRead(f);
});

for (const [label, data, emit] of [
    ['no event', null, false], ['null result', null, true], ['missing prompt', {}, true],
    ['non-array prompt', { prompt: 'invalid' }, true], ['empty prompt', { prompt: [] }, true],
]) test(`${label} rejects invalid dry-run output and restores history`, async t => {
    const f = fixture(t, { run: async (ctx, { eventSource }) => {
        ctx.chat[0].mes = 'Temporary mutation';
        if (emit) await eventSource.emit(AFTER_DATA, data, true);
    } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /未产出有效的 dry-run 消息列表/);
    assertClean(f, chat, originals);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.stats.transport.length, 0);
});

for (const [label, flag] of [['false', false], ['omitted', undefined]])
    test(`event with ${label} dryRun flag rejects instead of using ordinary generation data`, async t => {
        const f = fixture(t, { run: async (ctx, { eventSource }) => {
            await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, flag);
        } });
        const chat = f.state.chat, originals = chat.slice();
        await assert.rejects(f.runtime.simulate(), /模拟流程或聊天身份发生变化/);
        await settle(f);
        assertClean(f, chat, originals);
        assert.equal(f.stats.transport.length, 0);
    });

for (const first of [{ prompt: [{ role: 'user', content: 'First' }] }, { prompt: [] }, null])
    test(`duplicate results reject even when first result is ${JSON.stringify(first)}`, async t => {
        const f = fixture(t, { run: async (ctx, { eventSource }) => {
            await eventSource.emit(AFTER_DATA, first, true);
            await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
        } });
        const chat = f.state.chat, originals = chat.slice();
        await assert.rejects(f.runtime.simulate(), /多个组装结果/);
        await settle(f);
        assertClean(f, chat, originals);
        assert.equal(f.stats.transport.length, 0);
    });

test('prompt manager error rejects otherwise valid data after cleanup and restoration', async t => {
    const f = fixture(t, { promptError: 'Mock prompt budget failure', lateListener: async (_data, _dryRun, ctx) => {
        ctx.chat[0].mes = 'Temporary greeting';
    } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /提示词组装出错.*Mock prompt budget failure/);
    assertClean(f, chat, originals);
    assert.equal(f.stats.cleaned, true);
});

test('promptError is inspected after awaited listeners, not before the dry-run', async t => {
    let promptError = null;
    const f = fixture(t, { config: { getPromptError: () => promptError }, lateListener: async () => { promptError = 'Late plugin error'; } });
    await assert.rejects(f.runtime.simulate(), /提示词组装出错.*Late plugin error/);
    assert.equal(f.runtime.isBusy(), false);
});

for (const [label, failure] of [
    ['synchronous throw', () => { throw new Error('Synchronous dry-run failure'); }],
    ['asynchronous rejection', async () => { await Promise.resolve(); throw new Error('Asynchronous dry-run failure'); }],
]) test(`${label} from dryRunGenerate restores chat and unregisters listener`, async t => {
    const f = fixture(t, { config: { dryRunGenerate: ctx => { ctx.chat[0].mes = 'Temporary mutation'; return failure(); } } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /dry-run failure/);
    assertClean(f, chat, originals);
    assert.equal(f.stats.transport.length, 0);
});

test('generation failure after valid result still rejects, restores history, and permits next simulation', async t => {
    let fail = true;
    const f = fixture(t, { run: async (ctx, { eventSource }) => {
        ctx.chat[0].extra.marker = 'Temporary metadata';
        await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
        if (fail) throw new Error('Failed generation cleanup');
    } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /Failed generation cleanup/);
    assertClean(f, chat, originals);
    fail = false;
    await f.runtime.simulate();
    assertClean(f, chat, originals);
});

// Guard policy: model / alternate / external / write blocked; local read helpers allowed.
for (const [label, input, init, pattern] of [
    ['primary model POST', ENDPOINT, { method: 'POST', body: '{even invalid body is blocked' }, /意外尝试调用模型/],
    ['primary model GET', ENDPOINT, {}, /额外模型或外部/],
    ['alternate model POST', '/api/backends/text-completions/generate', { method: 'POST', body: '{}' }, /写入或不支持|额外模型/],
    ['alternate model GET', '/api/backends/text-completions/generate', {}, /额外模型或外部/],
    ['chat completions route', '/v1/chat/completions', {}, /额外模型或外部/],
    ['responses route', '/v1/responses', {}, /额外模型或外部/],
    ['messages route', '/v1/messages', {}, /额外模型或外部/],
    ['external provider', 'https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' }, /额外模型或外部/],
    ['external non-model GET', 'https://outside.invalid/config.json', {}, /额外模型或外部/],
    ['external local-looking tokenizer', 'https://outside.invalid/api/tokenizers/openai/count', { method: 'POST', body: '{}' }, /额外模型或外部/],
    ['chat save', '/api/chats/save', { method: 'POST', body: '{}' }, /写入或不支持/],
    ['worldinfo edit', '/api/worldinfo/edit', { method: 'POST', body: '{}' }, /写入或不支持/],
    ['settings save', '/api/settings/save', { method: 'POST', body: '{}' }, /写入或不支持/],
    ['local DELETE', '/api/chats/delete', { method: 'DELETE' }, /写入或不支持/],
    ['local PUT', '/api/files/upload', { method: 'PUT', body: 'file' }, /写入或不支持/],
    ['remote tokenizer POST', '/api/tokenizers/remote/openai', { method: 'POST', body: '{}' }, /写入或不支持/],
    ['remote tokenizer GET', '/api/tokenizers/remote/openai', {}, /写入或不支持/],
]) test(`simulation denies ${label} without delegating transport`, async t => {
    const f = fixture(t, { run: async (ctx, { host, eventSource, stats }) => {
        ctx.chat[0].mes = 'Temporary mutation before forbidden fetch';
        try { await host.fetch(input, init); }
        catch (error) { stats.error = error; }
        // A plugin swallowing AbortError must not turn this into a success.
        await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
    } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), pattern);
    await settle(f);
    assert.equal(f.stats.error.name, 'AbortError');
    assert.equal(f.stats.transport.length, 0);
    assert.equal(f.stats.stops, 1);
    assertClean(f, chat, originals);
});

for (const [input, init, pattern] of [
    [ENDPOINT, { method: 'POST', body: '{}' }, /意外尝试调用模型/],
    ['https://provider.invalid/v1/chat/completions', { method: 'POST', body: '{}' }, /额外模型或外部/],
    ['/api/chats/save', { method: 'POST', body: '{}' }, /写入或不支持/],
]) test(`draft denies ${input} without model transport or persisted writes and restores originals`, async t => {
    const f = fixture(t, { run: async (_ctx, { host }) => { await host.fetch(input, init); } });
    const chat = f.state.chat, originals = chat.slice(), values = structuredClone(chat);
    await assert.rejects(f.runtime.simulate({ mode: 'draft' }), pattern);
    await settle(f);
    assert.equal(f.stats.inputReads, 1);
    assert.equal(f.stats.attachmentReads, 1);
    assert.equal(f.stats.ordinaryGenerates, 0);
    assert.equal(f.stats.userSends, 0);
    assert.equal(f.stats.transport.length, 0);
    assertOriginals(chat, originals);
    assert.deepEqual(chat, values);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    assert.equal(f.runtime.isBusy(), false);
    assert.equal(f.eventSource.listenerCount(AFTER_DATA), 0);
});

test('local tokenizer, worldinfo/get and benign same-origin GET requests delegate and simulation succeeds', async t => {
    const calls = [
        ['/api/tokenizers/openai/count', { method: 'POST', body: '{}' }],
        ['/api/tokenizers/llama/encode', { method: 'POST', body: '{}' }],
        ['/api/worldinfo/get', { method: 'POST', body: '{"name":"book"}' }],
        ['/api/worldinfo/get?name=book', {}],
        ['/api/settings/get', {}],
    ];
    const f = fixture(t, { run: async (ctx, { host, eventSource }) => {
        for (const [input, init] of calls) assert.equal((await host.fetch(input, init)).ok, true);
        await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
    } });
    const result = await f.runtime.simulate();
    assert.deepEqual(f.stats.transport.map(call => call.input), calls.map(([input]) => input));
    assert.equal(result.current.kind, 'simulation');
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.stats.stops, 0);
});

for (const stopThrows of [false, true])
    test(`Request object primary transport is denied despite ${stopThrows ? 'throwing' : 'ineffective'} stopGeneration`, async t => {
        const f = fixture(t, { stopThrows, run: async (_ctx, { host }) => {
            await host.fetch(new Request(`${host.location.origin}${ENDPOINT}`, { method: 'POST', body: '{"messages":[]}' }));
        } });
        await assert.rejects(f.runtime.simulate(), /意外尝试调用模型/);
        await settle(f);
        assert.equal(f.stats.transport.length, 0);
        assert.equal(f.stats.stops, 1);
        assert.equal(f.stats.error.name, 'AbortError');
        assert.equal(f.runtime.isBusy(), false);
    });

test('later extension fetch patch is rewrapped outside its code for dry-run and restored on destroy', async t => {
    const f = fixture(t, { run: async (_ctx, { host }) => { await host.fetch(ENDPOINT, { method: 'POST', body: '{}' }); } });
    const earlierWrapper = f.host.fetch;
    let extensionCalls = 0;
    const extension = async (...args) => { extensionCalls++; return earlierWrapper(...args); };
    f.host.fetch = extension;
    await assert.rejects(f.runtime.simulate(), /意外尝试调用模型/);
    await settle(f);
    assert.equal(extensionCalls, 0);
    assert.equal(f.stats.transport.length, 0);
    f.runtime.destroy();
    assert.equal(f.host.fetch, extension);
    await realPost(f);
    assert.equal(extensionCalls, 1);
    assert.equal(f.stats.transport.length, 1);
    assert.equal(f.runtime.getLast(), null);
});

// Timeout/destroy reject the caller early but keep the guard and cloned chat
// in place until the underlying generation finally block has completed.
for (const stopThrows of [false, true])
    test(`timeout retains guard and clones until cleanup (${stopThrows ? 'throwing' : 'ineffective'} stop)`, async t => {
        const beforeData = deferred(), cleanupGate = deferred();
        const f = fixture(t, { beforeData, cleanupGate, timeoutMs: 20, stopThrows,
            run: async (ctx, { host, eventSource, stats }) => {
                try { await host.fetch(ENDPOINT, { method: 'POST', body: '{}' }); }
                catch (error) { stats.error = error; }
                await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
            } });
        await realPost(f);
        const baseline = f.runtime.getLast();
        const chat = f.state.chat, originals = chat.slice();
        const simulation = f.runtime.simulate();
        try {
            await f.started.promise;
            await assert.rejects(simulation, /模拟超时.*拦截会保留到组装结束/);
            assert.equal(f.runtime.isBusy(), true);
            assert.notEqual(chat[0], originals[0]);
            assert.equal(f.eventSource.listenerCount(AFTER_DATA), 1);
            await assert.rejects(f.runtime.simulate(), /正在生成\/预览/);
            await assert.rejects(f.runtime.captureCurrent(), /正在生成\/预览/);
            await assert.rejects(f.runtime.undoWrittenMessage(), /流程尚未结束/);
            beforeData.resolve();
            await f.cleanupStarted.promise;
            assert.equal(f.stats.error.name, 'AbortError');
            assert.equal(f.stats.transport.length, 1);
            assert.equal(f.runtime.isBusy(), true);
            assert.notEqual(chat[0], originals[0]);
            assert.deepEqual(f.runtime.getLast(), baseline);
            assert.equal(f.stats.stops, 1, 'stop is idempotent across timeout and late blocked fetch');
            cleanupGate.resolve();
            await settle(f);
            assertClean(f, chat, originals);
            assert.deepEqual(f.runtime.getLast(), baseline);
            assert.equal(f.host.fetch === f.originalFetch, false, 'live runtime still observes actual requests');
        } finally { beforeData.resolve(); cleanupGate.resolve(); }
    });

test('destroy retains guard, runtime ownership and clones until cleanup; fresh runtime is allowed only afterward', async t => {
    const beforeData = deferred(), cleanupGate = deferred();
    const f = fixture(t, { beforeData, cleanupGate, run: async (ctx, { host, eventSource, stats }) => {
        try { await host.fetch('/api/chats/save', { method: 'POST', body: '{}' }); }
        catch (error) { stats.error = error; }
        await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
    } });
    const chat = f.state.chat, originals = chat.slice();
    const simulation = f.runtime.simulate();
    try {
        await f.started.promise;
        const rejected = assert.rejects(simulation, /捕获器已关闭/);
        f.runtime.destroy();
        f.runtime.destroy();
        await rejected;
        assert.equal(f.runtime.isBusy(), true);
        assert.notEqual(chat[0], originals[0]);
        assert.notEqual(f.host.fetch, f.originalFetch);
        assert.equal(createExactCapture(f.config), f.runtime);
        await assert.rejects(f.runtime.simulate(), /已关闭/);
        beforeData.resolve();
        await f.cleanupStarted.promise;
        assert.equal(f.stats.transport.length, 0);
        assert.equal(f.stats.error.name, 'AbortError');
        assert.equal(f.stats.stops, 1);
        assert.equal(f.runtime.isBusy(), true);
        assert.notEqual(chat[0], originals[0]);
        cleanupGate.resolve();
        await settle(f);
        assertClean(f, chat, originals);
        assert.equal(f.host.fetch, f.originalFetch);
        assert.equal(f.runtime.getLast(), null);
        assert.equal(f.runtime.getLastPair(), null);
        const fresh = createExactCapture({ ...f.config, dryRunGenerate: async ctx => {
            await f.eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
        } });
        assert.notEqual(fresh, f.runtime);
        try { await fresh.simulate(); }
        finally { fresh.destroy(); }
        assertOriginals(chat, originals);
        assert.equal(f.stats.transport.length, 0);
    } finally { beforeData.resolve(); cleanupGate.resolve(); }
});

test('destroy after success restores fake fetch; retained wrapper is inert and cannot recreate baseline', async t => {
    const f = fixture(t);
    await realPost(f);
    await realPost(f, { model: 'second actual', messages: [] });
    await f.runtime.simulate();
    assert.ok(f.runtime.getLastPair().previous);
    const wrapper = f.host.fetch;
    f.runtime.destroy();
    assert.equal(f.host.fetch, f.originalFetch);
    await wrapper(ENDPOINT, { method: 'POST', body: '{"messages":[]}' });
    assert.equal(f.stats.transport.length, 3);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    await assert.rejects(f.runtime.simulate(), /已关闭/);
});

// Switching to a distinct exported array restores only the detached old one;
// switching contents of the shared exported array must preserve the new chat.
for (const when of ['before event', 'during cleanup'])
    test(`separate-array chat switch ${when} restores old identities and preserves new chat`, async t => {
        const beforeData = deferred(), cleanupGate = deferred();
        const f = fixture(t, { beforeData, cleanupGate });
        const oldChat = f.state.chat, originals = oldChat.slice();
        const newChat = [{ is_user: true, mes: 'New chat input', extra: { marker: 'new' } }];
        const newOriginals = newChat.slice();
        const simulation = f.runtime.simulate();
        const rejected = assert.rejects(simulation, /聊天身份发生变化|聊天已切换/);
        try {
            await f.started.promise;
            if (when === 'during cleanup') { beforeData.resolve(); await f.cleanupStarted.promise; }
            f.state.chatId = 'chat-2';
            f.state.chat = newChat;
            beforeData.resolve();
            await f.cleanupStarted.promise;
            assert.notEqual(oldChat[0], originals[0], 'restore waits for old generation cleanup');
            cleanupGate.resolve();
            await rejected;
            await settle(f);
            assertOriginals(oldChat, originals);
            assertOriginals(newChat, newOriginals);
            assert.equal(newChat[0].extra.marker, 'new');
            assert.equal(f.state.chat, newChat);
            assert.equal(f.runtime.isBusy(), false);
            assert.equal(f.eventSource.listenerCount(AFTER_DATA), 0);
            assert.equal(f.stats.transport.length, 0);
        } finally { beforeData.resolve(); cleanupGate.resolve(); }
    });

for (const when of ['before event', 'during cleanup'])
    test(`same shared-array chat switch ${when} preserves loaded new contents rather than old originals`, async t => {
        const beforeData = deferred(), cleanupGate = deferred();
        const f = fixture(t, { beforeData, cleanupGate });
        const sharedChat = f.state.chat, oldOriginals = sharedChat.slice();
        const newMessage = { is_user: true, mes: 'Loaded into shared exported array', extra: { marker: 'new' } };
        const simulation = f.runtime.simulate();
        const rejected = assert.rejects(simulation, /聊天身份发生变化|聊天已切换/);
        try {
            await f.started.promise;
            if (when === 'during cleanup') { beforeData.resolve(); await f.cleanupStarted.promise; }
            f.state.chatId = 'chat-2';
            sharedChat.splice(0, sharedChat.length, newMessage);
            beforeData.resolve();
            await f.cleanupStarted.promise;
            cleanupGate.resolve();
            await rejected;
            await settle(f);
            assert.equal(f.state.chat, sharedChat);
            assert.deepEqual(sharedChat, [newMessage]);
            assert.equal(sharedChat[0], newMessage);
            assert.equal(sharedChat.includes(oldOriginals[0]), false);
            assert.equal(newMessage.extra.marker, 'new');
            assert.equal(f.runtime.isBusy(), false);
            assert.equal(f.eventSource.listenerCount(AFTER_DATA), 0);
            assert.equal(f.stats.transport.length, 0);
        } finally { beforeData.resolve(); cleanupGate.resolve(); }
    });

test('replacement array with same chat key rejects result and restores detached original array only', async t => {
    const cleanupGate = deferred();
    const f = fixture(t, { cleanupGate });
    const oldChat = f.state.chat, originals = oldChat.slice();
    const simulation = f.runtime.simulate();
    const rejected = assert.rejects(simulation, /聊天已切换/);
    try {
        await f.cleanupStarted.promise;
        const replacement = [{ is_user: true, mes: 'Same key, different array' }];
        f.state.chat = replacement;
        cleanupGate.resolve();
        await rejected;
        await settle(f);
        assertOriginals(oldChat, originals);
        assert.equal(f.state.chat, replacement);
        assert.equal(replacement[0].mes, 'Same key, different array');
    } finally { cleanupGate.resolve(); }
});

test('useRecordCopies replaces nested values with clones and restores original entries and identities', () => {
    const nested = { child: { marker: 'original' } };
    const record = { nested, scalar: 'original scalar' };
    const restore = useRecordCopies(record);
    assert.notEqual(record.nested, nested);
    assert.notEqual(record.nested.child, nested.child);
    record.nested.child.marker = 'temporary';
    record.scalar = 'temporary';
    delete record.nested;
    record.added = { marker: 'temporary addition' };
    restore();
    assert.deepEqual(record, { nested, scalar: 'original scalar' });
    assert.equal(record.nested, nested);
    assert.equal(record.nested.child.marker, 'original');
    assert.equal(Object.hasOwn(record, 'added'), false);
});

for (const value of [undefined, null, false, 'text', []])
    test(`useRecordCopies ignores unsupported ${JSON.stringify(value)}`, () => {
        assert.equal(typeof useRecordCopies(value), 'function');
        assert.doesNotThrow(useRecordCopies(value));
    });

test('simulation restores nested metadata and extension-prompt originals without retaining transient additions', async t => {
    const metadataEntry = { nested: { marker: 'metadata original' } };
    const promptEntry = { value: 'original prompt', settings: { depth: 4 } };
    const metadata = { worldInfo: metadataEntry, scalar: 'original' };
    const prompts = { worldInfo: promptEntry };
    const f = fixture(t, { state: { chatMetadata: metadata, extensionPrompts: prompts }, run: async (ctx, { eventSource }) => {
        assert.equal(ctx.chatMetadata, metadata, 'exported metadata record stays bound');
        assert.equal(ctx.extensionPrompts, prompts, 'exported prompts record stays bound');
        assert.notEqual(ctx.chatMetadata.worldInfo, metadataEntry);
        assert.notEqual(ctx.chatMetadata.worldInfo.nested, metadataEntry.nested);
        assert.notEqual(ctx.extensionPrompts.worldInfo, promptEntry);
        assert.notEqual(ctx.extensionPrompts.worldInfo.settings, promptEntry.settings);
        ctx.chatMetadata.worldInfo.nested.marker = 'temporary';
        ctx.chatMetadata.scalar = 'temporary';
        ctx.chatMetadata.added = { marker: 'temporary' };
        ctx.extensionPrompts.worldInfo.value = 'temporary prompt';
        ctx.extensionPrompts.worldInfo.settings.depth = 99;
        ctx.extensionPrompts.added = { value: 'temporary' };
        await eventSource.emit(AFTER_DATA, { prompt: promptFor(ctx.chat) }, true);
    } });
    const chat = f.state.chat, originals = chat.slice();
    await f.runtime.simulate();
    assertClean(f, chat, originals);
    assert.deepEqual(metadata, { worldInfo: metadataEntry, scalar: 'original' });
    assert.equal(metadata.worldInfo, metadataEntry);
    assert.equal(metadata.worldInfo.nested.marker, 'metadata original');
    assert.deepEqual(prompts, { worldInfo: promptEntry });
    assert.equal(prompts.worldInfo, promptEntry);
    assert.equal(promptEntry.value, 'original prompt');
    assert.equal(promptEntry.settings.depth, 4);
});

test('failed simulation restores metadata and prompts alongside original chat objects', async t => {
    const metadataEntry = { nested: { marker: 'original' } }, promptEntry = { value: 'original' };
    const metadata = { original: metadataEntry }, prompts = { original: promptEntry };
    const f = fixture(t, { state: { chatMetadata: metadata, extensionPrompts: prompts }, run: async ctx => {
        ctx.chatMetadata.original.nested.marker = 'temporary';
        ctx.chatMetadata.added = 'temporary';
        ctx.extensionPrompts.original.value = 'temporary';
        ctx.extensionPrompts.added = 'temporary';
        throw new Error('Metadata generation failure');
    } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /Metadata generation failure/);
    assertClean(f, chat, originals);
    assert.deepEqual(metadata, { original: metadataEntry });
    assert.equal(metadata.original, metadataEntry);
    assert.equal(metadataEntry.nested.marker, 'original');
    assert.deepEqual(prompts, { original: promptEntry });
    assert.equal(prompts.original, promptEntry);
    assert.equal(promptEntry.value, 'original');
});

for (const reuse of [false, true])
    test(`chat switch with ${reuse ? 'reused shared' : 'separate'} metadata/prompt records preserves new contents`, async t => {
        const beforeData = deferred(), cleanupGate = deferred();
        const oldMetadataEntry = { nested: { marker: 'old metadata' } }, oldPromptEntry = { value: 'old prompt' };
        const oldMetadata = { original: oldMetadataEntry }, oldPrompts = { original: oldPromptEntry };
        const newMetadataEntry = { nested: { marker: 'new metadata' } }, newPromptEntry = { value: 'new prompt' };
        const f = fixture(t, { beforeData, cleanupGate, state: { chatMetadata: oldMetadata, extensionPrompts: oldPrompts } });
        const simulation = f.runtime.simulate();
        const rejected = assert.rejects(simulation, /聊天已切换/);
        try {
            await f.started.promise;
            beforeData.resolve();
            await f.cleanupStarted.promise;
            assert.notEqual(oldMetadata.original, oldMetadataEntry);
            assert.notEqual(oldPrompts.original, oldPromptEntry);
            f.state.chatId = 'chat-2';
            f.state.chat = [{ is_user: true, mes: 'New chat' }];
            const newMetadata = reuse ? oldMetadata : {};
            const newPrompts = reuse ? oldPrompts : {};
            if (reuse) { delete oldMetadata.original; delete oldPrompts.original; }
            newMetadata.loaded = newMetadataEntry;
            newPrompts.loaded = newPromptEntry;
            f.state.chatMetadata = newMetadata;
            f.state.extensionPrompts = newPrompts;
            cleanupGate.resolve();
            await rejected;
            await settle(f);
            assert.deepEqual(newMetadata, { loaded: newMetadataEntry });
            assert.deepEqual(newPrompts, { loaded: newPromptEntry });
            assert.equal(newMetadata.loaded, newMetadataEntry);
            assert.equal(newPrompts.loaded, newPromptEntry);
            if (!reuse) {
                assert.deepEqual(oldMetadata, { original: oldMetadataEntry });
                assert.deepEqual(oldPrompts, { original: oldPromptEntry });
                assert.equal(oldMetadata.original, oldMetadataEntry);
                assert.equal(oldPrompts.original, oldPromptEntry);
            }
            assert.equal(oldMetadataEntry.nested.marker, 'old metadata');
            assert.equal(oldPromptEntry.value, 'old prompt');
        } finally { beforeData.resolve(); cleanupGate.resolve(); }
    });

test('uncloneable metadata restores chat after early copy failure and performs no dry-run', async t => {
    const metadataEntry = { bad() {} };
    const f = fixture(t, { state: { chatMetadata: { original: metadataEntry } } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /clone/i);
    assertClean(f, chat, originals);
    assert.equal(f.stats.dryRuns, 0);
    assert.equal(f.state.chatMetadata.original, metadataEntry);
});

test('uncloneable extension prompts restores already-copied metadata and chat before generation', async t => {
    const metadataEntry = { nested: { marker: 'original' } }, promptEntry = { bad() {} };
    const f = fixture(t, { state: { chatMetadata: { original: metadataEntry }, extensionPrompts: { original: promptEntry } } });
    const chat = f.state.chat, originals = chat.slice();
    await assert.rejects(f.runtime.simulate(), /clone/i);
    assertClean(f, chat, originals);
    assert.equal(f.stats.dryRuns, 0);
    assert.equal(f.state.chatMetadata.original, metadataEntry);
    assert.equal(f.state.extensionPrompts.original, promptEntry);
});

for (const type of ['swipe', 'continue', 'normal'])
    test(`acknowledged ${type} actual updates BASE/pair for upcoming full current history`, async t => {
        const f = fixture(t);
        await realPost(f);
        const previous = f.runtime.getLast();
        await realPost(f, { type, model: `${type}-model`, messages: [{ role: 'user', content: type }] });
        const actual = f.runtime.getLast();
        assert.equal(actual.model, `${type}-model`);
        assert.deepEqual(f.runtime.getLastPair(), { previous, current: actual });
        const empty = await f.runtime.simulate();
        assert.deepEqual(empty.previous, actual);
        assert.deepEqual(empty.current.messages, promptFor(f.state.chat));
    });

test('normal actual dispatched after an assistant remains BASE, without inventing a prior user snapshot', async t => {
    const f = fixture(t);
    await f.host.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ type: 'normal', messages: [] }) });
    const actual = f.runtime.getLast();
    assert.equal(actual.kind, 'actual');
    assert.deepEqual(f.runtime.getLastPair(), { previous: null, current: actual });
    assert.deepEqual((await f.runtime.simulate()).previous, actual);
});

test('same host reuses runtime and concurrent simulation shares busy guard without second dry-run', async t => {
    const beforeData = deferred();
    const f = fixture(t, { beforeData });
    const second = createExactCapture({ ...f.config, getContext: () => { throw new Error('must reuse first runtime'); } });
    assert.equal(second, f.runtime);
    const simulation = f.runtime.simulate();
    try {
        await f.started.promise;
        await assert.rejects(second.simulate({ mode: 'draft' }), /正在生成\/预览/);
        assert.equal(f.stats.dryRuns, 1);
        beforeData.resolve();
        await simulation;
        assert.equal(second.isBusy(), false);
    } finally { beforeData.resolve(); }
});
