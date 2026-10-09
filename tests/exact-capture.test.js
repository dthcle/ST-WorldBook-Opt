import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactCapture, selectPayload, chatKey } from '../exact-capture.js';
import { buildComparison } from '../request-diff-ui.js';

const ENDPOINT = '/api/backends/chat-completions/generate';
const STAMP = '2026-01-01T00:00:00.000Z';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

// Each test owns its host. No global fetch patch, real network, or parallel-test dependency.
function fixture(options = {}) {
    const listeners = new Map();
    const transport = [];
    const state = {
        characterId: 0, groupId: null, chatId: 'chat-1', mainApi: 'openai',
        chat: [{ name: '用户', is_user: true, mes: '你好' }], generating: false,
        ...options.state,
    };
    const eventSource = {
        on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
        removeListener(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter(value => value !== fn)); },
        async emit(event, payload) {
            for (const fn of [...(listeners.get(event) ?? [])]) await fn(payload);
        },
    };
    let stops = 0, deletes = 0, snapshots = 0;
    const host = {
        location: { origin: 'https://st.invalid' },
        document: { getElementById: () => ({ value: options.input ?? '去海边' }) },
        async fetch(input, init) {
            transport.push({ input, init });
            if (options.transport) return options.transport(input, init);
            return { ok: true, status: 200 };
        },
    };
    const originalFetch = host.fetch;
    const reachedFetch = deferred(), cleanupStarted = deferred(), finished = deferred();
    const stats = { generated: 0, cleaned: false, payload: null, persisted: false, deleteCalls: [], saveCalls: [] };
    const deleteStarted = deferred();
    const persist = () => {
        stats.persisted = true;
        stats.saveCalls.push({ key: chatKey(state), chat: structuredClone(state.chat) });
    };
    const getContext = () => {
        snapshots++;
        const snapshotChat = state.chat;
        return {
            ...state, name1: '用户', eventSource,
            eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings_ready' },
            deleteMessage: options.fallbackUndo ? undefined : async (...args) => {
                stats.deleteCalls.push({ method: 'deleteMessage', args });
                deletes++;
                snapshotChat.splice(args[0], 1);
                persist(); // Native ST deleteMessage includes persistence.
            },
            deleteLastMessage: options.noDeleteLast ? undefined : async () => {
                stats.deleteCalls.push({ method: 'deleteLastMessage', args: [] });
                deletes++;
                snapshotChat.pop(); // ST deleteLastMessage updates chat/UI, but does not save.
                deleteStarted.resolve();
                if (options.deleteGate) await options.deleteGate.promise;
            },
            saveChat: options.noSaveChat ? undefined : async () => persist(),
            async generate(type) {
                assert.equal(type, 'normal');
                stats.generated++;
                state.generating = true;
                state.chat.push({ name: '用户', is_user: true, mes: '去海边', send_date: STAMP });
                const body = {
                    model: 'mock-model', chat_completion_source: 'custom',
                    messages: Array.from({ length: 6 }, (_, i) => ({ role: i ? 'user' : 'system', content: `temporary-${i}` })),
                    proxy_password: 'DO_NOT_RETAIN', reverse_proxy: 'https://secret.invalid',
                };
                stats.payload = body;
                try {
                    await eventSource.emit('settings_ready', body);
                    if (options.beforeFetch) await options.beforeFetch.promise;
                    if (options.noFetch) return;
                    if (options.localCalls) {
                        await host.fetch('/api/chats/save', { method: 'POST', body: '{}' });
                        await host.fetch('/api/tokenizers/openai/count', { method: 'POST', body: '{}' });
                    }
                    reachedFetch.resolve();
                    const finalBody = options.body ? options.body(body) : JSON.stringify(body);
                    if (options.request) {
                        const body = options.requestBodyGate ? new ReadableStream({
                            async start(controller) {
                                await options.requestBodyGate.promise;
                                controller.enqueue(new TextEncoder().encode(finalBody));
                                controller.close();
                            },
                        }) : finalBody;
                        await host.fetch(new Request(`${host.location.origin}${ENDPOINT}`, { method: 'POST', body,
                            ...(options.requestBodyGate ? { duplex: 'half' } : {}) }));
                    } else {
                        await host.fetch(options.url ?? ENDPOINT, { method: options.method ?? 'POST', body: finalBody });
                    }
                } catch (error) {
                    stats.error = error;
                    throw error;
                } finally {
                    cleanupStarted.resolve();
                    if (options.cleanupGate) await options.cleanupGate.promise;
                    stats.cleaned = true;
                    state.generating = false;
                    finished.resolve();
                }
            },
        };
    };
    const config = {
        host, getContext, isGenerating: () => state.generating,
        stopGeneration: () => { stops++; if (options.stopThrows) throw new Error('broken stop'); return false; },
        timeoutMs: options.timeoutMs ?? 60, now: () => STAMP,
        hasAttachment: () => options.attachment ?? false,
    };
    const runtime = createExactCapture(config);
    // Registered AFTER the runtime: mutation is awaited and performed in-place, as ST plugins do.
    eventSource.on('settings_ready', async body => {
        assert.equal(body.messages.length, 6);
        await Promise.resolve();
        body.messages.splice(0, body.messages.length,
            { role: 'system', content: '最终世界设定' }, { role: 'user', content: '去海边' });
    });
    return { runtime, config, host, originalFetch, state, stats, transport, eventSource, getContext,
        reachedFetch, cleanupStarted, finished, deleteStarted, stops: () => stops, deletes: () => deletes, snapshots: () => snapshots };
}

async function realPost(f, body = { model: 'real-model', messages: [{ role: 'system', content: '真实设定' }, { role: 'user', content: '真实输入' }] }, init = {}) {
    return f.host.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), ...init });
}
async function settle(f) { await f.finished.promise; await tick(); }

test('selectPayload clones comparable fields and excludes unsupported keys and credentials', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], model: 'm', chat_completion_source: 'custom',
        tools: [{ type: 'function' }], tool_choice: 'auto', json_schema: { name: 's' },
        proxy_password: 'secret', reverse_proxy: 'https://secret.invalid', unsupported: { token: 'secret' } };
    const selected = selectPayload(body);
    assert.deepEqual(Object.keys(selected).sort(), ['json_schema', 'messages', 'model', 'source', 'tool_choice', 'tools']);
    body.messages[0].content = 'mutated';
    assert.equal(selected.messages[0].content, 'hi');
    assert.equal(JSON.stringify(selected).includes('secret'), false);
    assert.throws(() => selectPayload({ model: 'm' }), /messages/);
    assert.throws(() => selectPayload(null), /messages/);
});

test('late awaited listener determines final snapshot; model preview is never delegated', async () => {
    const cleanupGate = deferred();
    const f = fixture({ cleanupGate, localCalls: true });
    let resolved = false;
    const capture = f.runtime.captureCurrent().then(value => { resolved = true; return value; });
    await f.cleanupStarted.promise;
    await tick();
    assert.equal(resolved, false, 'must wait for Generate finally cleanup');
    assert.equal(f.runtime.isBusy(), true);
    assert.deepEqual(f.transport.map(call => call.input), ['/api/chats/save', '/api/tokenizers/openai/count']);
    cleanupGate.resolve();
    const result = await capture;
    assert.deepEqual(result.current.messages, [{ role: 'system', content: '最终世界设定' }, { role: 'user', content: '去海边' }]);
    f.stats.payload.messages[0].content = 'later mutation';
    assert.equal(result.current.messages[0].content, '最终世界设定');
    assert.equal(result.previous, null);
    assert.equal(result.wroteMessage, true);
    assert.equal(f.stats.cleaned, true);
    assert.equal(f.runtime.isBusy(), false);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.stops(), 1);
    assert.equal(f.stats.error.name, 'AbortError', 'fetch must throw its own transport abort');
    assert.ok(result.warnings.length);
});

test('ordinary ST Generate saves only the final successful actual POST baseline', async () => {
    const f = fixture();
    await f.getContext().generate('normal');
    assert.equal(f.transport.length, 1);
    const baseline = f.runtime.getLast();
    assert.equal(baseline.messages.length, 2);
    assert.equal(baseline.messages[0].content, '最终世界设定');
    assert.equal(baseline.sentAt, STAMP);
    assert.equal(f.stops(), 0);
    const preview = await f.runtime.captureCurrent();
    assert.deepEqual(preview.previous, baseline);
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.equal(f.transport.length, 1);
});

test('SETTINGS_READY without fetch is never a baseline or successful preview', async () => {
    const f = fixture({ noFetch: true });
    await f.getContext().generate('normal');
    assert.equal(f.runtime.getLast(), null);
    await assert.rejects(f.runtime.captureCurrent(), /未到达.*最终请求/);
    assert.equal(f.transport.length, 0);
});

for (const stopThrows of [false, true]) test(`fetch interception is independent of ${stopThrows ? 'throwing' : 'ineffective'} stopGeneration`, async () => {
    const f = fixture({ stopThrows });
    await f.runtime.captureCurrent();
    assert.equal(f.transport.length, 0);
    assert.equal(f.stops(), 1);
    assert.equal(f.stats.cleaned, true);
});

test('timeout retains guard until underlying Generate settles, rejects second preview and blocks late fetch', async () => {
    const beforeFetch = deferred(), cleanupGate = deferred();
    const f = fixture({ beforeFetch, cleanupGate, timeoutMs: 20 });
    await realPost(f);
    const baseline = f.runtime.getLast();
    await assert.rejects(f.runtime.captureCurrent(), /超时/);
    assert.equal(f.runtime.isBusy(), true);
    await assert.rejects(f.runtime.captureCurrent(), /正在生成\/预览/);
    beforeFetch.resolve();
    await f.cleanupStarted.promise;
    assert.equal(f.transport.length, 1);
    assert.deepEqual(f.runtime.getLast(), baseline);
    assert.equal(f.runtime.isBusy(), true);
    cleanupGate.resolve();
    await settle(f);
    assert.equal(f.runtime.isBusy(), false);
    assert.deepEqual(f.runtime.getLast(), baseline);
    await f.runtime.captureCurrent();
    assert.equal(f.transport.length, 1);
});

test('destroy rejects pending caller immediately but keeps late-network guard until cleanup', async () => {
    const beforeFetch = deferred(), cleanupGate = deferred();
    const f = fixture({ beforeFetch, cleanupGate });
    const capture = f.runtime.captureCurrent();
    await tick();
    const rejected = assert.rejects(capture, /已关闭/);
    f.runtime.destroy();
    await rejected;
    assert.equal(f.runtime.isBusy(), true);
    assert.notEqual(f.host.fetch, f.originalFetch);
    const duringGuard = createExactCapture(f.config);
    assert.equal(duringGuard, f.runtime, 'destroy must not allow installing a fresh runtime over a live guard');
    await assert.rejects(duringGuard.captureCurrent(), /已关闭/);
    beforeFetch.resolve();
    await f.cleanupStarted.promise;
    assert.equal(f.transport.length, 0);
    assert.notEqual(f.host.fetch, f.originalFetch);
    cleanupGate.resolve();
    await settle(f);
    assert.equal(f.host.fetch, f.originalFetch);
    assert.equal(f.runtime.getLast(), null);
    await assert.rejects(f.runtime.captureCurrent(), /已关闭/);
    const fresh = createExactCapture(f.config);
    assert.notEqual(fresh, f.runtime, 'finished disposed runtime no longer occupies the host registry');
    await fresh.captureCurrent();
    assert.equal(f.transport.length, 0);
    fresh.destroy();
});

test('failed response and thrown transport never establish baseline', async () => {
    for (const transport of [async () => ({ ok: false, status: 500 }), async () => { throw new Error('network failed'); }]) {
        const f = fixture({ transport });
        await realPost(f).catch(error => assert.match(error.message, /network failed/));
        assert.equal(f.runtime.getLast(), null);
        assert.equal(f.transport.length, 1);
    }
});

test('quiet, impersonate, already aborted and malformed real requests do not replace baseline', async () => {
    const f = fixture();
    await realPost(f);
    const baseline = f.runtime.getLast();
    for (const type of ['quiet', 'impersonate']) await realPost(f, { type, messages: [{ role: 'user', content: type }] });
    const controller = new AbortController(); controller.abort();
    await realPost(f, undefined, { signal: controller.signal });
    await f.host.fetch(ENDPOINT, { method: 'POST', body: '{bad json' });
    await f.host.fetch(ENDPOINT, { method: 'GET' });
    assert.deepEqual(f.runtime.getLast(), baseline);
});

test('request aborted while awaiting successful response must not establish baseline', async () => {
    const response = deferred(), delegated = deferred();
    const f = fixture({ transport: async () => { delegated.resolve(); return response.promise; } });
    const controller = new AbortController();
    const sending = realPost(f, undefined, { signal: controller.signal });
    await delegated.promise;
    controller.abort();
    response.resolve({ ok: true, status: 200 });
    await sending;
    assert.equal(f.runtime.getLast(), null, 'an aborted request is not an acknowledged real baseline');
});

test('ordinary Request baseline retains starting chat identity during asynchronous body read', async () => {
    const bodyGate = deferred();
    const f = fixture();
    const stream = new ReadableStream({
        async start(controller) {
            await bodyGate.promise;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: 'original-chat', messages: [] })));
            controller.close();
        },
    });
    const sending = f.host.fetch(new Request(`${f.host.location.origin}${ENDPOINT}`, { method: 'POST', body: stream, duplex: 'half' }));
    await tick();
    f.state.chatId = 'new-chat';
    bodyGate.resolve();
    await sending;
    assert.equal(f.runtime.getLast(), null, 'old request must not become the new chat baseline');
    f.state.chatId = 'chat-1';
    assert.equal(f.runtime.getLast().model, 'original-chat');
});

test('clear while ordinary Request body is still being read invalidates the pending baseline', async () => {
    const bodyGate = deferred();
    const f = fixture();
    const stream = new ReadableStream({
        async start(controller) {
            await bodyGate.promise;
            controller.enqueue(new TextEncoder().encode('{"model":"cleared-request","messages":[]}'));
            controller.close();
        },
    });
    const sending = f.host.fetch(new Request(`${f.host.location.origin}${ENDPOINT}`, { method: 'POST', body: stream, duplex: 'half' }));
    await tick();
    f.runtime.clear();
    bodyGate.resolve();
    await sending;
    assert.equal(f.runtime.getLast(), null, 'a request already in progress before clear must not restore the baseline');
});

test('out-of-order successful responses retain newest request and clear invalidates pending acknowledgments', async () => {
    const responses = [deferred(), deferred(), deferred()];
    let index = 0;
    const f = fixture({ transport: () => responses[index++].promise });
    const first = realPost(f, { model: 'first', messages: [] });
    const second = realPost(f, { model: 'second', messages: [] });
    await tick();
    responses[1].resolve({ ok: true, status: 200 });
    await second;
    responses[0].resolve({ ok: true, status: 200 });
    await first;
    assert.equal(f.runtime.getLast().model, 'second');
    const pending = realPost(f, { model: 'cleared', messages: [] });
    await tick();
    f.runtime.clear();
    responses[2].resolve({ ok: true, status: 200 });
    await pending;
    assert.equal(f.runtime.getLast(), null);
});

test('chat switch before delayed preview fetch blocks transport and refuses undo ownership', async () => {
    const beforeFetch = deferred();
    const f = fixture({ beforeFetch });
    const capture = f.runtime.captureCurrent();
    const rejected = assert.rejects(capture, /聊天已切换/);
    await tick();
    f.state.chatId = 'other-chat';
    beforeFetch.resolve();
    await rejected;
    await settle(f);
    assert.equal(f.transport.length, 0);
    assert.equal(f.runtime.wroteChatMessage(), false);
});

test('same host has one runtime and two entry points share baseline and busy guard', async () => {
    const beforeFetch = deferred();
    const f = fixture({ beforeFetch });
    const entry2 = createExactCapture({ ...f.config, getContext: () => { throw new Error('must reuse runtime'); } });
    assert.equal(entry2, f.runtime);
    await realPost(f);
    assert.deepEqual(entry2.getLast(), f.runtime.getLast());
    const capture = f.runtime.captureCurrent();
    await assert.rejects(entry2.captureCurrent(), /正在生成\/预览/);
    beforeFetch.resolve();
    await capture;
    entry2.clear();
    assert.equal(f.runtime.getLast(), null);
});

test('context snapshots are refreshed: startup no chat, later chat, and baseline chat isolation', async () => {
    const f = fixture({ state: { characterId: null, chat: null } });
    await assert.rejects(f.runtime.captureCurrent(), /打开单人角色聊天/);
    f.state.characterId = 0; f.state.chat = [];
    await realPost(f);
    assert.ok(f.runtime.getLast());
    f.state.chatId = 'chat-2';
    assert.equal(f.runtime.getLast(), null);
    await f.runtime.captureCurrent();
    assert.ok(f.snapshots() > 3);
    assert.notEqual(chatKey({ ...f.state, chatId: 'a' }), chatKey({ ...f.state, chatId: 'b' }));
});

for (const [label, options, pattern] of [
    ['invalid JSON', { body: () => '{broken' }, /JSON|position|property|Expected/i],
    ['non-text body', { body: () => ({ messages: [] }) }, /JSON 文本/],
    ['missing messages', { body: () => '{"model":"m"}' }, /messages/],
    ['auxiliary quiet request', { body: body => JSON.stringify({ ...body, type: 'quiet' }) }, /辅助\/非普通/],
    ['external request', { url: 'https://provider.invalid/v1/chat/completions' }, /额外模型或外部/],
    ['alternate model endpoint', { url: '/api/backends/text-completions/generate' }, /额外模型或外部/],
    ['GET model route', { method: 'GET' }, /额外模型或外部/],
]) test(`preview fails closed for ${label}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.runtime.captureCurrent(), pattern);
    await settle(f);
    assert.equal(f.transport.length, 0);
    assert.equal(f.runtime.getLast(), null);
});

test('Request JSON body works for ordinary baseline and non-delegated preview', async () => {
    const f = fixture({ request: true });
    await f.getContext().generate('normal');
    assert.equal(f.transport.length, 1);
    assert.equal(f.runtime.getLast().messages.length, 2);
    const result = await f.runtime.captureCurrent();
    assert.equal(result.current.messages.length, 2);
    assert.equal(f.transport.length, 1);
});

test('timeout while cloning asynchronous Request body retains guard through late read and cleanup', async () => {
    const requestBodyGate = deferred(), cleanupGate = deferred();
    const f = fixture({ request: true, requestBodyGate, cleanupGate, timeoutMs: 20, stopThrows: true });
    await realPost(f);
    const baseline = f.runtime.getLast();
    const capture = f.runtime.captureCurrent();
    await f.reachedFetch.promise;
    await assert.rejects(capture, /超时/);
    assert.equal(f.runtime.isBusy(), true);
    await assert.rejects(f.runtime.captureCurrent(), /正在生成\/预览/);
    requestBodyGate.resolve();
    await f.cleanupStarted.promise;
    assert.equal(f.transport.length, 1);
    assert.equal(f.stats.error.name, 'AbortError');
    assert.equal(f.runtime.isBusy(), true);
    assert.deepEqual(f.runtime.getLast(), baseline);
    cleanupGate.resolve();
    await settle(f);
    assert.equal(f.runtime.isBusy(), false);
    assert.deepEqual(f.runtime.getLast(), baseline);
});

test('later extension fetch patch is rewrapped; preview stops outside it and real POST delegates once', async () => {
    const f = fixture();
    const previous = f.host.fetch;
    let extensionCalls = 0;
    const extensionWrapper = async (...args) => { extensionCalls++; return previous(...args); };
    f.host.fetch = extensionWrapper;
    await f.runtime.captureCurrent();
    assert.equal(extensionCalls, 0);
    assert.equal(f.transport.length, 0);
    await realPost(f);
    assert.equal(extensionCalls, 1);
    assert.equal(f.transport.length, 1);
    assert.equal(f.runtime.getLast().model, 'real-model');
    f.runtime.destroy();
    assert.equal(f.host.fetch, extensionWrapper, 'dispose restores the latest delegate without removing extension patch');
});

test('invalid JSON Request body is blocked without delegating', async () => {
    const f = fixture({ request: true, body: () => '{invalid' });
    await assert.rejects(f.runtime.captureCurrent(), /JSON|position|property|Expected/i);
    await settle(f);
    assert.equal(f.transport.length, 0);
});

for (const [label, options, pattern] of [
    ['busy', { state: { generating: true } }, /正在生成/],
    ['unsupported backend', { state: { mainApi: 'textgenerationwebui' } }, /Chat Completion/],
    ['group', { state: { groupId: 'group-1' } }, /群聊/],
    ['slash command', { input: ' /send hi' }, /斜杠命令/],
    ['attachment', { attachment: true }, /附件/],
]) test(`unsupported ${label} rejects before Generate or transport`, async () => {
    const f = fixture(options);
    await assert.rejects(f.runtime.captureCurrent(), pattern);
    assert.equal(f.stats.generated, 0);
    assert.equal(f.transport.length, 0);
});

test('normal undo removes exactly the appended preview user message; clear preserves undo', async () => {
    const f = fixture();
    const original = f.state.chat[0];
    await realPost(f);
    await f.runtime.captureCurrent();
    assert.equal(f.runtime.wroteChatMessage(), true);
    f.runtime.clear();
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.wroteChatMessage(), true);
    await f.runtime.undoWrittenMessage();
    assert.deepEqual(f.state.chat, [original]);
    assert.equal(f.deletes(), 1);
    assert.deepEqual(f.stats.deleteCalls, [{ method: 'deleteMessage', args: [1, undefined, false, false] }]);
    assert.equal(f.stats.persisted, true);
    assert.equal(f.stats.saveCalls.length, 1, 'native deleteMessage persists once, without an extra saveChat');
    assert.deepEqual(f.stats.saveCalls[0].chat, [original]);
    assert.equal(f.runtime.wroteChatMessage(), false);
    await assert.rejects(f.runtime.undoWrittenMessage(), /没有可安全撤回/);
});

test('fallback undo awaits deleteLastMessage then explicitly saves the same chat', async () => {
    const deleteGate = deferred();
    const f = fixture({ fallbackUndo: true, deleteGate });
    const original = f.state.chat[0];
    await f.runtime.captureCurrent();
    const undo = f.runtime.undoWrittenMessage();
    await f.deleteStarted.promise;
    assert.equal(f.stats.persisted, false, 'deleteLastMessage alone must not count as persistence');
    assert.equal(f.stats.saveCalls.length, 0, 'save must wait for asynchronous deletion');
    deleteGate.resolve();
    await undo;
    assert.deepEqual(f.stats.deleteCalls, [{ method: 'deleteLastMessage', args: [] }]);
    assert.equal(f.stats.persisted, true);
    assert.equal(f.stats.saveCalls.length, 1);
    assert.deepEqual(f.stats.saveCalls[0], { key: chatKey(f.state), chat: [original] });
    assert.equal(f.runtime.wroteChatMessage(), false);
});

for (const [label, options] of [
    ['missing saveChat', { noSaveChat: true }],
    ['missing deleteLastMessage', { noDeleteLast: true }],
]) test(`fallback undo rejects ${label} before deleting any message`, async () => {
    const f = fixture({ fallbackUndo: true, ...options });
    await f.runtime.captureCurrent();
    const before = structuredClone(f.state.chat);
    await assert.rejects(f.runtime.undoWrittenMessage(), /缺少可保存的安全撤回接口/);
    assert.deepEqual(f.state.chat, before);
    assert.equal(f.deletes(), 0);
    assert.deepEqual(f.stats.deleteCalls, []);
    assert.deepEqual(f.stats.saveCalls, []);
    assert.equal(f.runtime.wroteChatMessage(), true);
});

for (const [label, switchChat] of [
    ['chat key changes', f => { f.state.chatId = 'new-chat'; f.state.chat = [{ is_user: true, mes: '新聊天' }]; }],
    ['chat array identity changes', f => { f.state.chat = [{ is_user: true, mes: '替换聊天' }]; }],
]) test(`fallback undo never saves another chat when ${label} during awaited deletion`, async () => {
    const deleteGate = deferred();
    const f = fixture({ fallbackUndo: true, deleteGate });
    const oldChat = f.state.chat;
    const original = oldChat[0];
    await f.runtime.captureCurrent();
    const undo = f.runtime.undoWrittenMessage();
    const rejected = assert.rejects(undo, /聊天已切换.*保存未执行/);
    await f.deleteStarted.promise;
    switchChat(f);
    const newChat = structuredClone(f.state.chat);
    deleteGate.resolve();
    await rejected;
    assert.deepEqual(oldChat, [original], 'only the verified old preview message was deleted');
    assert.deepEqual(f.state.chat, newChat, 'new chat messages remain untouched');
    assert.equal(f.deletes(), 1);
    assert.deepEqual(f.stats.saveCalls, [], 'must not persist current new chat after deleting from old chat');
    assert.equal(f.stats.persisted, false);
});

for (const [label, mutate] of [
    ['chat switch', f => { f.state.chatId = 'other'; }],
    ['replaced chat array', f => { f.state.chat = [...f.state.chat]; }],
    ['different message identity', f => { f.state.chat[f.state.chat.length - 1] = { ...f.state.chat.at(-1) }; }],
    ['later real user', f => { f.state.chat.push({ name: '用户', is_user: true, mes: '下一条' }); }],
    ['later assistant', f => { f.state.chat.push({ name: '角色', is_user: false, mes: '回复' }); }],
    ['edited preview message', f => { f.state.chat.at(-1).mes = '编辑过'; }],
]) test(`undo rejects ${label} and never deletes unrelated messages`, async () => {
    const f = fixture();
    await f.runtime.captureCurrent();
    mutate(f);
    const before = structuredClone(f.state.chat);
    await assert.rejects(f.runtime.undoWrittenMessage(), /已变化/);
    assert.deepEqual(f.state.chat, before);
    assert.equal(f.deletes(), 0);
});

test('undo cannot run during retained timeout guard', async () => {
    const beforeFetch = deferred();
    const f = fixture({ beforeFetch, timeoutMs: 20 });
    await assert.rejects(f.runtime.captureCurrent(), /超时/);
    await assert.rejects(f.runtime.undoWrittenMessage(), /流程尚未结束/);
    beforeFetch.resolve();
    await settle(f);
    await f.runtime.undoWrittenMessage();
    assert.equal(f.state.chat.length, 1);
});

test('destroy without pending generation restores fetch and leaves retained references inert', async () => {
    const f = fixture();
    const wrapper = f.host.fetch;
    await realPost(f);
    f.runtime.destroy();
    assert.equal(f.host.fetch, f.originalFetch);
    assert.equal(f.runtime.getLast(), null);
    await wrapper(ENDPOINT, { method: 'POST', body: '{"messages":[]}' });
    assert.equal(f.transport.length, 2);
    assert.equal(f.runtime.getLast(), null);
});

test('buildComparison handles absent baseline and compares final message lists', () => {
    const current = { messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'two' }] };
    for (const previous of [null, undefined, {}, { messages: null }]) assert.equal(buildComparison(previous, current), null);
    const diff = buildComparison({ messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'one' }] }, current);
    assert.equal(diff.firstDifference.index, 1);
    assert.equal(diff.rows.length, 2);
    assert.throws(() => buildComparison({ messages: [] }, { model: 'm' }), /缺少消息列表/);
});
