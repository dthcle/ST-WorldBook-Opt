import test from 'node:test';
import assert from 'node:assert/strict';
import { createExactCapture, selectPayload, chatKey } from '../exact-capture.js';
import { buildComparison } from '../request-diff-ui.js';

function fixture({ api = 'openai', group = null, generating = false, characterId = 0, settingsEvent = 'settings_ready' } = {}) {
    const listeners = new Map();
    // Mutable session state, mirroring SillyTavern's module-level variables.
    const session = { characterId, groupId: group, chatId: 'chat-1', mainApi: api, chat: [{ name: '用户', is_user: true, mes: '你好' }] };
    const stopCalls = [];
    const eventTypes = settingsEvent ? { CHAT_COMPLETION_SETTINGS_READY: settingsEvent } : {};
    const eventSource = {
        on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
        removeListener(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== fn)); },
        async emit(event, payload) { for (const fn of listeners.get(event) ?? []) await fn(payload); return true; },
    };
    // getContext() returns a fresh snapshot object on every call, exactly like SillyTavern.
    const getContext = () => ({
        characterId: session.characterId,
        groupId: session.groupId,
        chatId: session.chatId,
        name1: '用户',
        mainApi: session.mainApi,
        chat: session.chat,
        eventTypes,
        eventSource,
        generate(type) {
            assert.equal(type, 'normal');
            if (generating) return Promise.reject(new Error('busy'));
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    session.chat.push({ name: '用户', is_user: true, mes: '去海边' });
                    eventSource.emit(settingsEvent, {
                        model: 'mock-model', chat_completion_source: 'custom',
                        messages: [
                            { role: 'system', content: '世界设定' },
                            { role: 'user', content: '去海边' },
                        ],
                        proxy_password: 'MUST_NOT_BE_KEPT',
                    }).then(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), reject);
                }, 0);
            });
        },
        async deleteLastMessage() { session.chat.pop(); },
    });
    const runtime = createExactCapture({
        getContext,
        isGenerating: () => generating,
        stopGeneration: () => { stopCalls.push(Date.now()); return true; },
        timeoutMs: 200,
        now: () => '2026-01-01T00:00:00.000Z',
    });
    return { session, runtime, stopCalls, listeners, getContext };
}

test('selectPayload keeps only comparable fields and drops credentials', () => {
    const payload = selectPayload({ model: 'm', chat_completion_source: 'custom', messages: [{ role: 'user', content: 'hi' }], proxy_password: 'secret', reverse_proxy: 'http://x' });
    assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'source']);
    assert.equal(JSON.stringify(payload).includes('secret'), false);
    assert.equal(JSON.stringify(payload).includes('reverse_proxy'), false);
});

test('selectPayload rejects payloads without a message list', () => {
    assert.throws(() => selectPayload({ model: 'm' }), /消息列表/);
    assert.throws(() => selectPayload(null), /消息列表/);
});

test('chatKey separates chats so a stale baseline is not reused', () => {
    const ctx = { characterId: 0, groupId: null, chatId: 'a' };
    assert.equal(chatKey(ctx), chatKey({ ...ctx }));
    assert.notEqual(chatKey(ctx), chatKey({ ...ctx, chatId: 'b' }));
});

test('context is re-read per call, so a chat opened after install still works', async () => {
    // Regression: getContext() snapshots are frozen at page load, when no chat is open.
    const { runtime, session } = fixture({ characterId: null });
    session.chat = [];
    await assert.rejects(runtime.captureCurrent(), /还没有打开角色聊天/);
    // The user now opens a single-character chat.
    session.characterId = 0;
    session.chat = [{ name: '用户', is_user: true, mes: '你好' }];
    const result = await runtime.captureCurrent();
    assert.equal(result.previous, null);
    assert.equal(result.current.messages.at(-1).content, '去海边');
});

test('baseline captured before a chat switch is not attributed to the new chat', async () => {
    const { runtime, session, getContext } = fixture();
    await getContext().eventSource.emit('settings_ready', { model: 'm', messages: [{ role: 'user', content: 'a' }] });
    assert.ok(runtime.getLast());
    session.chatId = 'chat-2';
    assert.equal(runtime.getLast(), null);
});

test('real generation stores the baseline without aborting', async () => {
    const { runtime, getContext, stopCalls } = fixture();
    await getContext().eventSource.emit('settings_ready', { model: 'm', chat_completion_source: 'c', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(stopCalls.length, 0, 'a real request must not be aborted');
    const last = runtime.getLast();
    assert.equal(last.model, 'm');
    assert.equal(last.messages.length, 1);
    assert.equal(last.sentAt, '2026-01-01T00:00:00.000Z');
});

test('capture aborts synchronously at the settings event and returns that payload', async () => {
    const { runtime, stopCalls } = fixture();
    const result = await runtime.captureCurrent();
    assert.equal(stopCalls.length, 1, 'stopGeneration must be called exactly once');
    assert.equal(result.current.messages.at(-1).content, '去海边');
    assert.equal(result.previous, null, 'no baseline existed yet');
    assert.equal(result.wroteMessage, true);
    assert.ok(result.warnings.some(text => text.includes('提示词查看器')));
});

test('capture does not overwrite the previous real baseline', async () => {
    const { runtime, getContext } = fixture();
    await getContext().eventSource.emit('settings_ready', { model: 'm', chat_completion_source: 'c', messages: [{ role: 'user', content: '真实' }] });
    const result = await runtime.captureCurrent();
    assert.equal(result.previous.messages.at(-1).content, '真实');
    assert.equal(result.current.messages.at(-1).content, '去海边');
    assert.equal(runtime.getLast().messages.at(-1).content, '真实', 'baseline must survive the aborted capture');
});

test('capture reports the added chat message and can undo it', async () => {
    const { runtime, session } = fixture();
    const lengthBefore = session.chat.length;
    await runtime.captureCurrent();
    assert.equal(session.chat.length, lengthBefore + 1);
    assert.equal(runtime.wroteChatMessage(), true);
    await runtime.undoWrittenMessage();
    assert.equal(session.chat.length, lengthBefore);
    assert.equal(runtime.wroteChatMessage(), false);
    await assert.rejects(runtime.undoWrittenMessage(), /没有需要撤回的消息/);
});

test('undo refuses when the last message is not ours', async () => {
    const { runtime, session } = fixture();
    await runtime.captureCurrent();
    session.chat.push({ name: '角色', is_user: false, mes: 'AI 回复' });
    await assert.rejects(runtime.undoWrittenMessage(), /聊天已变化/);
    assert.equal(session.chat.length, 3);
});

test('abort rejection from generate is swallowed', async () => {
    const { runtime } = fixture();
    const result = await runtime.captureCurrent();
    assert.ok(result.current.messages.length > 0);
});

test('concurrent capture is refused', async () => {
    const { runtime } = fixture();
    const first = runtime.captureCurrent();
    assert.equal(runtime.isBusy(), true);
    await assert.rejects(runtime.captureCurrent(), /已有一次捕获/);
    await first;
    assert.equal(runtime.isBusy(), false);
});

test('busy generation is refused before touching the pipeline', async () => {
    const { runtime, stopCalls } = fixture({ generating: true });
    await assert.rejects(runtime.captureCurrent(), /正在生成/);
    assert.equal(stopCalls.length, 0);
});

test('non chat-completion backends are refused', async () => {
    const { runtime } = fixture({ api: 'textgenerationwebui' });
    await assert.rejects(runtime.captureCurrent(), /聊天补全/);
});

test('group chats are refused', async () => {
    const { runtime } = fixture({ group: 'g1' });
    await assert.rejects(runtime.captureCurrent(), /群聊/);
});

test('missing capture event fails fast at construction', () => {
    const { getContext } = fixture();
    const ctx = getContext();
    assert.throws(() => createExactCapture({ getContext: () => ({ ...ctx, eventTypes: {} }), stopGeneration: () => {} }), /缺少请求捕获事件/);
    assert.throws(() => createExactCapture({ getContext: () => ctx }), /缺少取消生成接口/);
});

test('timeout rejects when the pipeline never reports a payload', async () => {
    const listeners = new Map();
    const getContext = () => ({
        characterId: 0, groupId: null, chatId: 'c', chat: [], mainApi: 'openai',
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ready' },
        eventSource: { on: (e, f) => listeners.set(e, f), removeListener() {}, emit: async () => true },
        generate: () => new Promise(() => {}),
    });
    const runtime = createExactCapture({ getContext, stopGeneration: () => {}, timeoutMs: 30 });
    await assert.rejects(runtime.captureCurrent(), /超时/);
});

test('destroy removes the listener and clears state', async () => {
    const { runtime, getContext, listeners } = fixture();
    await getContext().eventSource.emit('settings_ready', { model: 'm', messages: [{ role: 'user', content: 'a' }] });
    runtime.destroy();
    assert.equal((listeners.get('settings_ready') ?? []).length, 0);
    assert.equal(runtime.getLast(), null);
    await getContext().eventSource.emit('settings_ready', { model: 'm', messages: [{ role: 'user', content: 'b' }] });
    assert.equal(runtime.getLast(), null);
    await assert.rejects(runtime.captureCurrent(), /已销毁/);
});

test('malformed payload during capture rejects instead of resolving empty', async () => {
    const { runtime, getContext } = fixture();
    const capture = runtime.captureCurrent();
    await getContext().eventSource.emit('settings_ready', { model: 'm' });
    await assert.rejects(capture, /消息列表/);
});

test('buildComparison returns null without a previous request instead of throwing', () => {
    const current = { messages: [{ role: 'user', content: 'hi' }] };
    assert.equal(buildComparison(null, current), null);
    assert.equal(buildComparison(undefined, current), null);
    assert.equal(buildComparison({}, current), null);
    assert.equal(buildComparison({ messages: null }, current), null);
});

test('buildComparison compares matching payloads from the first message', () => {
    const previous = { messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'one' }] };
    const current = { messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'two' }] };
    const diff = buildComparison(previous, current);
    assert.equal(diff.firstDifference.index, 1);
    assert.equal(diff.rows.length, 2);
});

test('buildComparison rejects a current payload without messages', () => {
    assert.throws(() => buildComparison({ messages: [] }, { model: 'm' }), /缺少消息列表/);
});
