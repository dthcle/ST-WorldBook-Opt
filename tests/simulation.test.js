import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactCapture, selectPayload, chatKey } from '../exact-capture.js';

const ENDPOINT = '/api/backends/chat-completions/generate';
const STAMP = '2026-02-03T04:05:06.000Z';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const history = () => [
    { name: '角色', is_user: false, mes: '开场白' },
    { name: '用户', is_user: true, mes: '上一次输入' },
    { name: '角色', is_user: false, mes: '上一轮回复' },
];

// Each test owns its host. No global fetch patch, no real network, no parallel-test dependency.
// The fixture's raw fetch is the wrapper's delegate, so the runtime decides what is recorded or
// intercepted exactly as it will in SillyTavern.
function fixture(t, options = {}) {
    const state = {
        characterId: 0, groupId: null, chatId: 'chat-1', mainApi: 'openai',
        chat: options.chat ?? history(), generating: false, ...options.state,
    };
    const transport = [];
    let composer = options.composer ?? '';
    const host = {
        location: { origin: 'https://st.invalid' },
        async fetch(input, init) {
            transport.push({ input, init });
            if (options.transport) return options.transport(input, init, transport.length);
            return { ok: true, status: 200 };
        },
    };
    const originalFetch = host.fetch;
    const stats = { generated: 0, dryRunSeen: [], composerReads: 0, attachmentReads: 0, stops: 0, appended: 0 };
    const finished = deferred();
    const getContext = () => ({
        ...state, name1: '用户',
        getChatCompletionModel: () => 'fixture-model',
        chatCompletionSettings: { chat_completion_source: 'custom' },
        async deleteMessage(index) {
            if (index !== state.chat.length - 1) throw new Error('deleteMessage must only remove the last message');
            state.chat.splice(index, 1);
        },
        async generate(type, _options = {}, dryRun) {
            assert.equal(type, 'normal');
            stats.generated++;
            stats.dryRunSeen.push(dryRun);
            state.generating = true;
            try {
                if (options.appendUserMessage) {
                    stats.appended++;
                    state.chat.push({ name: '用户', is_user: true, mes: '插件追加的消息', send_date: STAMP });
                }
                if (options.beforeFetch) await options.beforeFetch.promise;
                const body = {
                    type: options.generationType ?? 'normal', model: 'fixture-model', chat_completion_source: 'custom',
                    messages: state.chat.map(message => ({ role: message.is_user ? 'user' : 'assistant', content: message.mes })),
                    proxy_password: 'DO_NOT_RETAIN', reverse_proxy: 'https://secret.invalid',
                };
                await host.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
            } finally {
                state.generating = false;
                finished.resolve();
            }
        },
    });
    const runtime = createExactCapture({
        host, getContext,
        isGenerating: () => state.generating,
        stopGeneration: () => { stats.stops++; if (options.stopThrows) throw new Error('broken stop'); },
        timeoutMs: options.timeoutMs ?? 2000, now: () => STAMP,
        getInput: () => { stats.composerReads++; return composer; },
        hasAttachment: () => { stats.attachmentReads++; return options.attachment ?? false; },
    });
    t.after(() => runtime.destroy());
    return { runtime, state, host, originalFetch, transport, stats, getContext, finished,
        setComposer: value => { composer = value; } };
}

// An ordinary acknowledged send: go through the installed wrapper so it can record the baseline.
function realPost(f, body = { model: 'real-model', messages: [{ role: 'user', content: '真实输入' }] }, init = {}) {
    return f.host.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(body), ...init });
}
async function settle(f) { await f.finished.promise; await tick(); }

test('selectPayload clones comparable fields and never retains credentials', () => {
    const selected = selectPayload({ messages: [{ role: 'user', content: 'hi' }], model: 'm', chat_completion_source: 'custom',
        tools: [{ type: 'function' }], proxy_password: 'secret', reverse_proxy: 'https://secret.invalid' });
    assert.deepEqual(Object.keys(selected).sort(), ['messages', 'model', 'source', 'tools']);
    assert.equal(JSON.stringify(selected).includes('secret'), false);
    assert.throws(() => selectPayload({ model: 'm' }), /messages/);
});

// --- composer safety: the whole point of the rewrite -------------------------------------

for (const [label, composer] of [['plain text', '去海边'], ['whitespace only', '   '], ['slash command', '/send hi'], ['newline', '\n']]) {
    test(`previewNext refuses to run for a non-empty composer: ${label}`, async t => {
        const f = fixture(t, { composer });
        await assert.rejects(f.runtime.previewNext(), /清空输入框/);
        assert.equal(f.stats.generated, 0);
        assert.equal(f.transport.length, 0, 'no network request may happen for a refused preview');
        assert.equal(f.runtime.isBusy(), false);
    });
}

test('previewNext refuses pending attachments before generating', async t => {
    const f = fixture(t, { composer: '', attachment: true });
    await assert.rejects(f.runtime.previewNext(), /附件/);
    assert.equal(f.stats.generated, 0);
    assert.equal(f.transport.length, 0);
});

test('previewNext only reads the composer once to verify emptiness and never writes it', async t => {
    const f = fixture(t, { composer: '' });
    await f.runtime.previewNext();
    assert.equal(f.stats.composerReads, 1);
    assert.equal(f.stats.attachmentReads, 1);
    await settle(f);
});

// --- the preview runs the REAL pipeline, not a dry run -----------------------------------

test('previewNext uses real assembly (dryRun is falsy) and cuts the model transport', async t => {
    const f = fixture(t, { composer: '' });
    await realPost(f);
    const baseline = f.runtime.getLast();
    assert.equal(f.transport.length, 1, 'the ordinary send is delegated');
    const result = await f.runtime.previewNext();
    assert.deepEqual(f.stats.dryRunSeen, [undefined], 'the preview must NOT request a dry run');
    assert.equal(f.transport.length, 1, 'the preview model POST must never reach the transport');
    assert.deepEqual(result.previous, baseline);
    assert.equal(result.current.kind, 'preview');
    assert.equal(result.wroteMessage, false);
    assert.equal(f.stats.stops, 1, 'the preview stops the generation it intercepted');
    assert.ok(result.warnings.some(text => /真实发送流水线/.test(text)));
    await settle(f);
});

test('previewNext leaves the chat untouched when the empty assembly appends nothing', async t => {
    const f = fixture(t, { composer: '' });
    const before = f.state.chat.slice();
    await realPost(f);
    await f.runtime.previewNext();
    assert.deepEqual(f.state.chat, before);
    assert.equal(f.runtime.wroteChatMessage(), false);
    await settle(f);
});

test('previewNext reports and undoes a message appended by an empty-send setting or plugin', async t => {
    const f = fixture(t, { composer: '', appendUserMessage: true });
    const original = f.state.chat.slice();
    await realPost(f);
    const result = await f.runtime.previewNext();
    assert.equal(result.wroteMessage, true);
    assert.equal(f.runtime.wroteChatMessage(), true);
    assert.equal(f.state.chat.length, original.length + 1);
    await f.runtime.undoWrittenMessage();
    assert.deepEqual(f.state.chat, original);
    assert.equal(f.runtime.wroteChatMessage(), false);
    await settle(f);
});

test('previewNext without any acknowledged real request returns previous null instead of inventing a BASE', async t => {
    const f = fixture(t, { composer: '' });
    const result = await f.runtime.previewNext();
    assert.equal(result.previous, null);
    assert.equal(result.current.kind, 'preview');
    assert.equal(f.runtime.getLast(), null);
    await settle(f);
});

test('repeated previews never advance or replace the real BASE', async t => {
    const f = fixture(t, { composer: '' });
    await realPost(f);
    const baseline = f.runtime.getLast();
    await f.runtime.previewNext();
    await f.runtime.previewNext();
    assert.deepEqual(f.runtime.getLast(), baseline);
    await settle(f);
});

// --- refusals and fail-closed behaviour --------------------------------------------------

for (const [label, options, pattern] of [
    ['unsupported api', { state: { mainApi: 'textgenerationwebui' } }, /Chat Completion/],
    ['group chat', { state: { groupId: 'group-1' } }, /群聊/],
    ['missing character', { state: { characterId: null } }, /单人角色聊天/],
    ['missing chat', { state: { chat: null } }, /单人角色聊天/],
    ['busy host', { state: { generating: true } }, /正在生成/],
]) {
    test(`preview refuses ${label} before generating or touching the network`, async t => {
        const f = fixture(t, { ...options, composer: '' });
        await assert.rejects(f.runtime.previewNext(), pattern);
        assert.equal(f.stats.generated, 0);
        assert.equal(f.transport.length, 0);
    });
}

test('preview fails closed for an auxiliary non-normal request without delegating', async t => {
    const f = fixture(t, { composer: '', generationType: 'quiet' });
    await assert.rejects(f.runtime.previewNext(), /辅助\/非普通/);
    assert.equal(f.transport.length, 0);
    await settle(f);
});

// --- provenance of the real baseline and the consecutive pair ---------------------------

test('a real baseline is recorded only after a successful acknowledged response', async t => {
    const f = fixture(t);
    assert.equal(f.runtime.getLast(), null);
    await realPost(f);
    const baseline = f.runtime.getLast();
    assert.equal(baseline.kind, 'actual');
    assert.equal(baseline.model, 'real-model');
    assert.equal(baseline.sentAt, STAMP);
    assert.equal(JSON.stringify(baseline).includes('secret'), false);
    assert.equal(f.runtime.getLastPair().previous, null, 'the first acknowledged actual has no predecessor');
    assert.equal(f.runtime.getLastPair().current.model, 'real-model');
});

test('failed, thrown and malformed transports never establish or overwrite a baseline', async t => {
    for (const transport of [async () => ({ ok: false, status: 500 }), async () => { throw new Error('network failed'); }]) {
        const f = fixture(t, { transport });
        await realPost(f).catch(error => assert.match(error.message, /network failed/));
        assert.equal(f.runtime.getLast(), null);
        assert.equal(f.transport.length, 1);
    }
    const ok = fixture(t);
    await realPost(ok);
    const baseline = ok.runtime.getLast();
    await ok.host.fetch(ENDPOINT, { method: 'POST', body: '{bad json' });
    await ok.host.fetch(ENDPOINT, { method: 'GET' });
    assert.deepEqual(ok.runtime.getLast(), baseline);
});

test('quiet and impersonate requests never replace the acknowledged baseline', async t => {
    const f = fixture(t);
    await realPost(f);
    const baseline = f.runtime.getLast();
    for (const type of ['quiet', 'impersonate']) await realPost(f, { type, messages: [] });
    assert.deepEqual(f.runtime.getLast(), baseline);
});

test('an aborted real request never establishes a baseline', async t => {
    const f = fixture(t);
    const controller = new AbortController(); controller.abort();
    await realPost(f, undefined, { signal: controller.signal });
    assert.equal(f.runtime.getLast(), null);
});

test('out-of-order acknowledgments keep the newest BASE and let a late older ack fill the predecessor', async t => {
    const responses = [deferred(), deferred(), deferred()];
    const f = fixture(t, { transport: (input, init, call) => responses[call - 1].promise });
    const first = realPost(f, { model: 'first', messages: [] });
    const third = realPost(f, { model: 'third', messages: [] });
    await tick();
    responses[1].resolve({ ok: true, status: 200 });
    await third;
    assert.equal(f.runtime.getLast().model, 'third');
    assert.equal(f.runtime.getLastPair().previous, null, 'no acknowledged predecessor yet');
    responses[0].resolve({ ok: true, status: 200 });
    await first;
    const pair = f.runtime.getLastPair();
    assert.equal(pair.current.model, 'third', 'the newest acknowledged actual stays the BASE');
    assert.equal(pair.previous.model, 'first', 'a late older ack fills the predecessor without regressing last');
});

test('clear invalidates an in-flight acknowledgment and removes baseline and pair', async t => {
    const response = deferred();
    const f = fixture(t, { transport: () => response.promise });
    const pending = realPost(f, { model: 'cleared', messages: [] });
    await tick();
    f.runtime.clear();
    response.resolve({ ok: true, status: 200 });
    await pending;
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
});

test('baseline and pair are chat-scoped and never bridge a different chat', async t => {
    const f = fixture(t);
    await realPost(f, { model: 'chat-one', messages: [] });
    assert.equal(f.runtime.getLast().model, 'chat-one');
    f.state.chatId = 'chat-2';
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
    assert.notEqual(chatKey({ characterId: 0, chatId: 'a' }), chatKey({ characterId: 0, chatId: 'b' }));
    f.state.chatId = 'chat-1';
    assert.equal(f.runtime.getLast().model, 'chat-one');
});

// --- lifecycle guards -------------------------------------------------------------------

test('one runtime per host is reused and concurrent work shares the busy guard', async t => {
    const beforeFetch = deferred();
    const f = fixture(t, { composer: '', beforeFetch });
    const shared = createExactCapture({ host: f.host, getContext: () => { throw new Error('must reuse runtime'); },
        stopGeneration: () => {}, getInput: () => '' });
    assert.equal(shared, f.runtime);
    const preview = f.runtime.previewNext();
    await tick();
    await assert.rejects(f.runtime.previewNext(), /正在生成\/预览/);
    beforeFetch.resolve();
    await preview;
    await settle(f);
});

test('timeout keeps the guard until the underlying generation settles', async t => {
    const beforeFetch = deferred();
    const f = fixture(t, { composer: '', beforeFetch, timeoutMs: 20, stopThrows: true });
    await assert.rejects(f.runtime.previewNext(), /超时/);
    assert.equal(f.runtime.isBusy(), true);
    await assert.rejects(f.runtime.previewNext(), /正在生成\/预览/);
    beforeFetch.resolve();
    await settle(f);
    assert.equal(f.runtime.isBusy(), false);
    assert.equal(f.transport.length, 0, 'no model transport was ever delegated');
    assert.equal(f.runtime.getLast(), null);
});

test('a chat switch during assembly rejects the preview and delegates nothing', async t => {
    const beforeFetch = deferred();
    const f = fixture(t, { composer: '', beforeFetch });
    const preview = f.runtime.previewNext();
    const rejected = assert.rejects(preview, /聊天已切换/);
    await tick();
    f.state.chatId = 'other-chat';
    beforeFetch.resolve();
    await rejected;
    assert.equal(f.transport.length, 0);
    await settle(f);
});

test('destroy during a pending preview rejects the caller and keeps the guard until cleanup', async t => {
    const beforeFetch = deferred();
    const f = fixture(t, { composer: '', beforeFetch });
    const preview = f.runtime.previewNext();
    await tick();
    const rejected = assert.rejects(preview, /已关闭/);
    f.runtime.destroy();
    await rejected;
    assert.equal(f.runtime.isBusy(), true);
    assert.notEqual(f.host.fetch, f.originalFetch);
    beforeFetch.resolve();
    await settle(f);
    assert.equal(f.host.fetch, f.originalFetch);
    await assert.rejects(f.runtime.previewNext(), /已关闭/);
});

test('destroy after a settled run restores fetch and clears baseline and pair', async t => {
    const f = fixture(t, { composer: '' });
    await realPost(f);
    await f.runtime.previewNext();
    await settle(f);
    f.runtime.destroy();
    assert.equal(f.host.fetch, f.originalFetch);
    assert.equal(f.runtime.getLast(), null);
    assert.equal(f.runtime.getLastPair(), null);
});

test('legacy captureCurrent still runs the real pipeline and cuts the transport', async t => {
    const f = fixture(t, { composer: '去海边' });
    await realPost(f);
    const result = await f.runtime.captureCurrent();
    assert.ok(result.previous);
    assert.equal(result.current.kind, 'preview');
    assert.equal(f.transport.length, 1);
    assert.ok(result.warnings.some(text => /最终浏览器→酒馆/.test(text)));
    await settle(f);
});

test('a later extension fetch patch is rewrapped and stays in place after destroy', async t => {
    const f = fixture(t, { composer: '' });
    const previous = f.host.fetch;
    let extensionCalls = 0;
    const extensionWrapper = async (...args) => { extensionCalls++; return previous(...args); };
    f.host.fetch = extensionWrapper;
    await f.runtime.previewNext();
    assert.equal(extensionCalls, 0, 'the preview must stop before any outer extension patch');
    await settle(f);
    f.runtime.destroy();
    assert.equal(f.host.fetch, extensionWrapper, 'dispose restores the latest delegate, not the extension patch');
});
