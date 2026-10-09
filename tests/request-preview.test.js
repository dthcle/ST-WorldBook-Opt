import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestPreview, chatKey, selectRequestInput, assertPreviewTextSafe, restoreState } from '../request-preview.js';

// All requests are host-local mocks. Never touch global fetch or a real network.
const endpoint = '/api/backends/chat-completions/generate';
const prompt = [{ role: 'system', content: 'system' }, { role: 'user', content: 'prepared:hello' }];
const events = Object.fromEntries(['GENERATE_AFTER_DATA', 'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_BEFORE_COMBINE_PROMPTS', 'GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY', 'WORLDINFO_ENTRIES_LOADED', 'WORLDINFO_SCAN_DONE', 'WORLD_INFO_ACTIVATED', 'OTHER'].map(name => [name, name]));
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function fixture(overrides = {}) {
    const calls = { fetch: [], emit: [], generate: [], preprocess: [] };
    const host = {
        location: { origin: 'https://tavern.test' },
        async fetch(input, options) {
            assert.equal(this, host);
            calls.fetch.push({ input, options });
            if (overrides.fetchError) throw overrides.fetchError;
            return overrides.response ?? { ok: true, status: 200 };
        },
    };
    const nativeFetch = host.fetch;
    const ctx = {
        mainApi: 'openai', characterId: 0, chatId: 'chat-a', groupId: null, name1: 'User',
        chat: [{ mes: 'old', extra: { nested: { value: 1 }, tags: ['old'] } }],
        chatMetadata: { variables: { old: 'metadata' } },
        extensionPrompts: { memory: { value: 'memory', position: 0 } },
        extensionSettings: { variables: { global: 'original' } },
        characters: [{ description: '{{char}}' }], powerUserSettings: {},
        chatCompletionSettings: { chat_completion_source: 'openai', prompts: [] },
        eventTypes: events,
        eventSource: { async emit(...args) { calls.emit.push({ receiver: this, args }); } },
        getChatCompletionModel: () => 'preview-model',
        substituteParams: text => `prepared:${text}`,
    };
    let current = ctx;
    const manager = { messages: ['old'], overriddenPrompts: { old: true }, tokenUsage: { total: 1 }, error: null, tokenHandler: { counts: { nested: { total: 1 } } } };
    const textarea = { value: 'hello', readOnly: false };
    ctx.generate = async (...args) => {
        calls.generate.push(args);
        assert.equal(args[0], 'normal');
        assert.ok(args[1].signal instanceof AbortSignal);
        assert.equal(args[2], true, 'generation must use dryRun=true');
        assert.equal(textarea.value, '');
        assert.equal(textarea.readOnly, true);
        assert.equal(ctx.chat.at(-1).mes, 'prepared:hello');
        if (overrides.generate) await overrides.generate({ ctx, host, manager, textarea, calls, switchContext: value => { current = value; } });
        else await ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt });
    };
    const preview = createRequestPreview({ getContext: () => current, host, promptManager: () => manager,
        isGenerating: () => overrides.generating ?? false,
        hasAttachment: () => overrides.attachment ?? false,
        preprocess: text => { calls.preprocess.push(text); return overrides.preprocess ? overrides.preprocess(text) : text; },
        activeBooks: async value => overrides.activeBooks ? overrides.activeBooks(value, v => { current = v; }) : [],
    });
    const observer = host.fetch;
    const body = { messages: [{ role: 'user', content: 'actual' }], model: 'actual-model', chat_completion_source: 'openai', proxy_password: 'SECRET_PASSWORD', api_key: 'SECRET_KEY', reverse_proxy: 'https://secret.test', temperature: 0.7 };
    return { ctx, host, manager, textarea, preview, calls, body, nativeFetch, observer,
        switchContext: value => { current = value; },
        async capture(extra = {}) { await host.fetch(endpoint, { method: 'POST', headers: { authorization: 'SECRET_HEADER' }, body: JSON.stringify({ ...body, ...extra }) }); },
    };
}
function savedState(f) {
    const targets = [f.ctx.chat, f.ctx.chatMetadata, f.ctx.extensionPrompts, f.ctx.extensionSettings];
    const nested = [f.ctx.chat[0], f.ctx.chat[0].extra, f.ctx.chat[0].extra.nested, f.ctx.chat[0].extra.tags, f.ctx.chatMetadata.variables, f.ctx.extensionPrompts.memory, f.ctx.extensionSettings.variables];
    const snapshots = structuredClone(targets);
    const emit = f.ctx.eventSource.emit;
    const fields = ['messages', 'overriddenPrompts', 'tokenUsage', 'error'].map(k => [k, f.manager[k]]);
    const counts = f.manager.tokenHandler.counts;
    const countNested = counts.nested;
    return () => {
        assert.deepEqual(targets, snapshots);
        assert.deepEqual([f.ctx.chat, f.ctx.chatMetadata, f.ctx.extensionPrompts, f.ctx.extensionSettings], targets);
        [f.ctx.chat[0], f.ctx.chat[0].extra, f.ctx.chat[0].extra.nested, f.ctx.chat[0].extra.tags, f.ctx.chatMetadata.variables, f.ctx.extensionPrompts.memory, f.ctx.extensionSettings.variables].forEach((ref, i) => assert.equal(ref, nested[i]));
        targets.forEach((ref, i) => assert.equal(ref, [f.ctx.chat, f.ctx.chatMetadata, f.ctx.extensionPrompts, f.ctx.extensionSettings][i]));
        for (const [k, ref] of fields) assert.equal(f.manager[k], ref);
        assert.equal(f.manager.tokenHandler.counts, counts);
        assert.equal(counts.nested, countNested);
        assert.deepEqual(counts, { nested: { total: 1 } });
        assert.equal(f.ctx.eventSource.emit, emit);
        assert.equal(f.textarea.value, 'hello');
        assert.equal(f.textarea.readOnly, false);
        assert.equal(f.preview.isPreviewing(), false);
    };
}
function mutate({ ctx, manager }) {
    ctx.chat[0].mes = 'changed';
    ctx.chat[0].extra.nested.value = 9;
    ctx.chat[0].extra.tags.push('changed');
    ctx.chat[0].extra.added = true;
    ctx.chatMetadata.variables.old = 'changed';
    ctx.chatMetadata.added = true;
    ctx.extensionPrompts.memory.value = 'changed';
    ctx.extensionPrompts.added = { value: 'new' };
    ctx.extensionSettings.variables.global = 'changed';
    ctx.extensionSettings.variables.new = 'new';
    for (const field of ['messages', 'overriddenPrompts', 'tokenUsage', 'error']) manager[field] = { replacement: true };
    manager.tokenHandler.counts.nested.total = 99;
    manager.tokenHandler.counts.added = true;
}

test('captures actual POST string body, redacts transport secrets and returns defensive copies', async () => {
    const f = fixture();
    await f.capture();
    const last = f.preview.getLast();
    assert.deepEqual(last.messages, f.body.messages);
    assert.equal(last.model, 'actual-model');
    assert.equal(last.source, 'openai');
    assert.equal(last.key, chatKey(f.ctx));
    assert.equal(last.status, '酒馆后端已响应 HTTP 200');
    assert.ok(!Number.isNaN(Date.parse(last.sentAt)));
    assert.deepEqual(Object.keys(last).sort(), ['key', 'messages', 'model', 'sentAt', 'source', 'status']);
    assert.doesNotMatch(JSON.stringify(last), /SECRET|secret\.test|authorization|proxy_password|api_key|temperature/);
    last.messages[0].content = 'mutated';
    assert.equal(f.preview.getLast().messages[0].content, 'actual');
    assert.equal(f.calls.fetch.length, 1);
    f.preview.clear();
    assert.equal(f.preview.getLast(), null);
    f.preview.destroy();
    assert.equal(f.host.fetch, f.nativeFetch);
});

test('dry-run uses AFTER_DATA prompt, skips plugin events, restores nested refs and empty textarea', async () => {
    const f = fixture({ generate: async state => {
        mutate(state);
        for (const event of Object.values(events).filter(e => e !== events.OTHER)) await state.ctx.eventSource.emit(event, { prompt });
        await state.ctx.eventSource.emit(events.OTHER, 'forwarded');
        await state.host.fetch('/api/tokenizers/openai/count', { method: 'POST', body: '{}' });
    } });
    await f.capture();
    const check = savedState(f);
    const result = await f.preview.simulate('hello', f.textarea);
    check();
    assert.equal(f.host.fetch, f.observer);
    assert.equal(f.calls.generate.length, 1);
    assert.equal(f.calls.fetch.filter(c => c.input === endpoint).length, 1, 'no extra model request');
    assert.equal(f.calls.fetch.length, 2, 'only local tokenizer read is added');
    assert.equal(f.calls.emit.length, 1);
    assert.equal(f.calls.emit[0].receiver, f.ctx.eventSource);
    assert.deepEqual(f.calls.emit[0].args, [events.OTHER, 'forwarded']);
    assert.deepEqual(result.current, { messages: prompt, model: 'preview-model', source: 'openai' });
    assert.deepEqual(result.previous, f.preview.getLast());
    assert.equal(result.warnings.length, 4);
    result.current.messages[0].content = 'changed';
    assert.equal(prompt[0].content, 'system');
    f.preview.destroy();
});

for (const caught of [false, true]) test(`dry-run generation fetch is blocked even when error is ${caught ? 'caught' : 'uncaught'}`, async () => {
    const f = fixture({ generate: async state => {
        mutate(state);
        if (caught) {
            assert.throws(() => state.host.fetch(endpoint, { method: 'POST', body: '{}' }), { name: 'PreviewNetworkBlockedError' });
            await state.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt });
        } else await state.host.fetch(endpoint, { method: 'POST', body: '{}' });
    } });
    await f.capture();
    const check = savedState(f);
    await assert.rejects(f.preview.simulate('hello', f.textarea), caught ? /不允许的网络操作/ : /Network request blocked/);
    check();
    assert.equal(f.calls.fetch.length, 1);
    assert.equal(f.host.fetch, f.observer);
    f.preview.destroy();
});

test('generation exception restores state and releases guard for another attempt', async () => {
    const failure = new Error('generate failed');
    const f = fixture({ generate: async state => { mutate(state); throw failure; } });
    await f.capture();
    const check = savedState(f);
    await assert.rejects(f.preview.simulate('hello', f.textarea), e => e === failure);
    check();
    f.ctx.generate = async () => { await f.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt }); };
    await f.preview.simulate('hello', f.textarea);
    check();
    assert.equal(f.calls.fetch.length, 1);
    f.preview.destroy();
});

const disabled = [
    ['no baseline', {}, () => {}, 'hello', /没有捕获/],
    ['session changed', {}, f => { f.ctx.chatId = 'different'; }, 'hello', /没有捕获/],
    ['group chat', {}, f => { f.ctx.groupId = 'group'; }, 'hello', /群聊/],
    ['unsupported backend', {}, f => { f.ctx.mainApi = 'textgenerationwebui'; }, 'hello', /仅支持/],
    ['no character', {}, f => { f.ctx.characterId = null; }, 'hello', /单人角色/],
    ['empty input', {}, () => {}, '  ', /空输入/],
    ['slash command', {}, () => {}, '  /send secret', /斜杠/],
    ['attachments', { attachment: true }, () => {}, 'hello', /附件/],
    ['squash system messages', {}, f => { f.ctx.chatCompletionSettings.squash_system_messages = true; }, 'hello', /合并系统/],
    ['function calling', {}, f => { f.ctx.chatCompletionSettings.function_calling = true; }, 'hello', /工具调用/],
    ['baseline tools', {}, () => {}, 'hello', /工具或结构化/],
    ['baseline schema', {}, () => {}, 'hello', /工具或结构化/],
    ['already generating', { generating: true }, () => {}, 'hello', /正在生成/],
    ['state-writing macro', {}, () => {}, '{{setvar::x::1}}', /写入、随机或未知宏/],
    ['unknown macro', {}, () => {}, '{{custom_macro}}', /未知宏/],
    ['EJS', {}, () => {}, '<% save() %>', /EJS/],
    ['nested chat macro', {}, f => { f.ctx.chat[0].extra.template = '{{setglobalvar::x::1}}'; }, 'hello', /未知宏/],
    ['extension prompt macro', {}, f => { f.ctx.extensionPrompts.memory.value = '{{random::x::y}}'; }, 'hello', /未知宏/],
    ['worldbook macro', { activeBooks: async () => [{ entries: { 1: { content: '{{unknown}}' } } }] }, () => {}, 'hello', /未知宏/],
    ['preprocessed macro', { preprocess: () => '{{setvar::x::1}}' }, () => {}, 'hello', /未知宏/],
];
for (const [name, options, setup, input, expected] of disabled) test(`fails closed: ${name}`, async () => {
    const f = fixture(options);
    setup(f);
    if (name !== 'no baseline') await f.capture(name === 'baseline tools' ? { tools: [{ type: 'function' }] } : name === 'baseline schema' ? { json_schema: { name: 'schema' } } : {});
    if (name === 'session changed') f.ctx.chatId = 'changed-again';
    const check = savedState(f);
    await assert.rejects(f.preview.simulate(input, f.textarea), expected);
    check();
    assert.equal(f.calls.generate.length, 0);
    assert.equal(f.calls.fetch.length, name === 'no baseline' ? 0 : 1);
    assert.equal(f.host.fetch, f.observer);
    f.preview.destroy();
});

for (const phase of ['books', 'generate']) test(`session switch during ${phase} cancels and restores original context`, async () => {
    let f;
    const replacement = { characterId: 1, chatId: 'new', groupId: null, chat: [{ mes: 'untouched' }] };
    const opts = phase === 'books'
        ? { activeBooks: async (ctx, switchContext) => { ctx.chatMetadata.variables.old = 'changed'; switchContext(replacement); return []; } }
        : { generate: async state => { mutate(state); state.switchContext(replacement); await state.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt }); } };
    f = fixture(opts);
    await f.capture();
    const check = savedState(f);
    await assert.rejects(f.preview.simulate('hello', f.textarea), /聊天已切换/);
    check();
    assert.deepEqual(replacement.chat, [{ mes: 'untouched' }]);
    assert.equal(f.preview.getLast(), null);
    assert.equal(f.calls.fetch.length, 1);
    f.preview.destroy();
});

test('concurrent preview rejects while first is awaiting asynchronous book loading', async () => {
    const entered = deferred(), release = deferred();
    const f = fixture({ activeBooks: async () => { entered.resolve(); await release.promise; return []; } });
    await f.capture();
    const first = f.preview.simulate('hello', f.textarea);
    await entered.promise;
    assert.equal(f.preview.isPreviewing(), true);
    await assert.rejects(f.preview.simulate('hello', f.textarea), /正在生成或预览/);
    assert.equal(f.calls.generate.length, 0);
    release.resolve();
    await first;
    assert.equal(f.calls.generate.length, 1);
    assert.equal(f.preview.isPreviewing(), false);
    f.preview.destroy();
});

test('cooperative host fetch wrapper survives restoration and retained guard becomes inert', async () => {
    let wrapper;
    const f = fixture({ generate: async state => {
        const guarded = state.host.fetch;
        wrapper = function (...args) { return Reflect.apply(guarded, this, args); };
        state.host.fetch = wrapper;
        await state.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt });
    } });
    await f.capture();
    await f.preview.simulate('hello', f.textarea);
    assert.equal(f.host.fetch, wrapper);
    await f.capture({ messages: [{ role: 'user', content: 'after preview' }] });
    assert.equal(f.calls.fetch.length, 2);
    assert.equal(f.preview.getLast().messages[0].content, 'after preview');
    f.preview.destroy();
    assert.equal(f.host.fetch, wrapper, 'destroy must not clobber another wrapper');
});

for (const assembled of [undefined, { prompt: [] }, { prompt: 'not messages' }]) test(`invalid assembled prompt (${JSON.stringify(assembled)}) rejects with restoration`, async () => {
    const f = fixture({ generate: async state => { mutate(state); await state.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, assembled); } });
    await f.capture();
    const check = savedState(f);
    await assert.rejects(f.preview.simulate('hello', f.textarea), /未返回可比较/);
    check();
    f.preview.destroy();
});

test('observer forwards malformed, external and non-string payloads without capturing', async () => {
    const f = fixture();
    await f.host.fetch(endpoint, { method: 'POST', body: '{broken' });
    await f.host.fetch('https://other.test' + endpoint, { method: 'POST', body: JSON.stringify(f.body) });
    await f.host.fetch(endpoint, { method: 'POST', body: f.body });
    await f.host.fetch('/unrelated', { body: JSON.stringify(f.body) });
    assert.equal(f.calls.fetch.length, 4);
    assert.equal(f.preview.getLast(), null);
    f.preview.destroy();
});

for (const response of [{ ok: false, status: 503 }, new Error('cancelled')]) test(`observer preserves ${response instanceof Error ? 'fetch error' : 'HTTP error'} status`, async () => {
    const f = fixture(response instanceof Error ? { fetchError: response } : { response });
    if (response instanceof Error) await assert.rejects(f.capture(), e => e === response);
    else await f.capture();
    assert.match(f.preview.getLast().status, response instanceof Error ? /发送失败 \/ 已取消/ : /后端错误 HTTP 503/);
    f.preview.destroy();
});

test('observer captures only POST, accepting lowercase post and ignoring other methods', async () => {
    const f = fixture();
    const body = JSON.stringify(f.body);
    for (const method of [undefined, 'GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
        await f.host.fetch(endpoint, { ...(method ? { method } : {}), body });
        assert.equal(f.preview.getLast(), null, `${method ?? 'default GET'} must not establish a baseline`);
    }
    await f.host.fetch(endpoint, { method: 'post', body });
    const baseline = f.preview.getLast();
    assert.deepEqual(baseline.messages, f.body.messages);
    await f.host.fetch(endpoint, { method: 'GET', body: JSON.stringify({ ...f.body, messages: [{ role: 'user', content: 'not a generation' }] }) });
    assert.deepEqual(f.preview.getLast(), baseline, 'GET must not replace the existing POST baseline');
    assert.equal(f.calls.fetch.length, 8, 'observation never suppresses ordinary requests');
    f.preview.destroy();
});

for (const throwing of [false, true]) test(`replaced and deleted nested slots restore original references on ${throwing ? 'failure' : 'success'}`, async () => {
    const failure = new Error('replacement failure');
    const f = fixture({ generate: async state => {
        mutate(state);
        // Keep root bindings intact, as native ST does, but replace/remove slots.
        const first = state.ctx.chat[0];
        first.extra.nested = { value: 42 };
        first.extra.tags = ['replacement'];
        state.ctx.chat[0] = { mes: 'replacement', extra: {} };
        state.ctx.chatMetadata.variables = { replacement: true };
        delete state.ctx.extensionPrompts.memory;
        state.ctx.extensionSettings.variables = null;
        if (throwing) throw failure;
        await state.ctx.eventSource.emit(events.GENERATE_AFTER_DATA, { prompt });
    } });
    await f.capture();
    const check = savedState(f);
    if (throwing) await assert.rejects(f.preview.simulate('hello', f.textarea), error => error === failure);
    else await f.preview.simulate('hello', f.textarea);
    check();
    assert.equal(f.host.fetch, f.observer);
    assert.equal(f.calls.fetch.length, 1);
    f.preview.destroy();
});

test('destroy makes an observer retained by an outer fetch wrapper inert without clobbering it', async () => {
    const f = fixture();
    const retainedObserver = f.host.fetch;
    let wrapperCalls = 0;
    const wrapper = function (...args) {
        wrapperCalls++;
        return Reflect.apply(retainedObserver, this, args);
    };
    f.host.fetch = wrapper;
    await f.capture();
    assert.ok(f.preview.getLast());
    f.preview.destroy();
    assert.equal(f.host.fetch, wrapper);
    assert.equal(f.preview.getLast(), null);
    await f.capture({ messages: [{ role: 'user', content: 'after destroy' }] });
    assert.equal(f.preview.getLast(), null, 'retained observer must not recapture requests after destroy');
    await retainedObserver.call(f.host, endpoint, { method: 'POST', body: JSON.stringify(f.body) });
    assert.equal(f.preview.getLast(), null, 'direct use of a retained observer must also stay inert');
    assert.equal(wrapperCalls, 2);
    assert.equal(f.calls.fetch.length, 3, 'all requests still reach the mock fetch');
    f.preview.destroy();
    assert.equal(f.host.fetch, wrapper);
});

test('read-only native macros are accepted; selection and restore helpers retain only safe state', () => {
    assert.doesNotThrow(() => assertPreviewTextSafe(['{{user}} {{getvar::x}} {{getglobalvar::y}} {{// comment}}', { nested: '{{char}}' }]));
    assert.throws(() => selectRequestInput({ prompt: 'not messages' }), /不是可比较/);
    const body = { messages: [], model: 'm', tools: [{ type: 'function' }], tool_choice: 'auto', json_schema: { name: 's' }, api_key: 'secret' };
    const selected = selectRequestInput(body);
    assert.deepEqual(Object.keys(selected).sort(), ['json_schema', 'messages', 'model', 'source', 'tool_choice', 'tools']);
    selected.tools[0].type = 'changed';
    assert.equal(body.tools[0].type, 'function');
    const target = { list: [{ value: 2 }], added: true };
    const list = target.list, nested = list[0];
    restoreState(target, { list: [{ value: 1 }] });
    assert.equal(target.list, list);
    assert.equal(target.list[0], nested);
    assert.deepEqual(target, { list: [{ value: 1 }] });
    assert.equal(chatKey({ characterId: 0, getCurrentChatId: () => 'fallback' }), '[0,null,"fallback"]');
});
