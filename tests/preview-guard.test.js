import test from 'node:test';
import assert from 'node:assert/strict';
import { installPreviewGuard } from '../preview-guard.js';

const origin = 'https://tavern.test';
const safeError = { name: 'PreviewNetworkBlockedError', message: 'Network request blocked during prompt preview' };

function mockHost() {
    const calls = { fetch: [], open: [], send: [], sockets: [] };
    class XMLHttpRequest {
        open(...args) { calls.open.push({ receiver: this, args }); }
        send(...args) { calls.send.push({ receiver: this, args }); }
    }
    class WebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor(...args) { calls.sockets.push(args); }
    }
    const host = {
        location: { origin }, Request,
        fetch(...args) {
            assert.equal(this, host, 'native fetch must keep its host receiver');
            calls.fetch.push(args);
            return Promise.resolve({ ok: true });
        },
        XMLHttpRequest, WebSocket,
    };
    return { host, calls };
}

// Tests use isolated mock hosts and node's single-process test runner. They do
// not print payloads, headers, full URLs, or monkey-patch the real global fetch.
test('one original request; preview blocks generation; finally restores on failure', async () => {
    const { host, calls } = mockHost();
    const native = host.fetch;
    await host.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
    assert.equal(calls.fetch.length, 1);
    const guard = installPreviewGuard(host);
    try {
        assert.notEqual(host.fetch, native, 'installation must be synchronous');
        assert.throws(() => host.fetch('/api/backends/chat-completions/generate', { method: 'POST' }), safeError);
        assert.equal(calls.fetch.length, 1, 'preview must never reach native generation');
        throw new Error('preview failed');
    } catch (error) {
        assert.equal(error.message, 'preview failed');
    } finally {
        guard.restore();
    }
    assert.equal(host.fetch, native);
    await host.fetch('/generate');
    assert.equal(calls.fetch.length, 2);
    guard.restore();
});

test('fetch supports string, URL and Request without consuming body or headers', async () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host, { origin });
    const request = new Request(`${origin}/api/tokenizers/openai/count?model=gpt-4`, {
        method: 'POST', body: 'private body', headers: { 'x-private': 'private header' },
    });
    const init = { method: 'POST' };
    Object.defineProperties(init, {
        body: { get() { throw new Error('guard read body'); } },
        headers: { get() { throw new Error('guard read headers'); } },
    });
    try {
        await host.fetch('/api/worldinfo/get', init);
        await host.fetch(new URL(`${origin}/api/characters/get`));
        const detachedFetch = host.fetch;
        await detachedFetch(request);
        assert.equal(request.bodyUsed, false);
        assert.equal(calls.fetch.length, 3);
        assert.equal(calls.fetch[0][1], init);
        assert.equal(calls.fetch[2][0], request);
        assert.deepEqual(guard.blocked, []);
    } finally { guard.restore(); }
});

test('allowlisted local tokenizer endpoints accept queries but matching is exact', async () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    try {
        for (const path of [
            '/api/worldinfo/get?name=private', '/api/characters/get?name=private',
            '/api/tokenizers/openai/count?model=gpt-4', '/api/tokenizers/llama/encode',
            '/api/tokenizers/llama3/decode', '/api/tokenizers/command-r/encode',
            '/api/tokenizers/nerdstash_v2/decode', '/api/tokenizers/gpt2/encode',
        ]) await host.fetch(path, { method: 'POST' });
        assert.equal(calls.fetch.length, 8);
        for (const path of [
            '/api/worldinfo/get/edit', '/api/worldinfo/get/', '/api/characters/get-all',
            '/api/tokenizers/openai/count/generate', '/api/tokenizers/openai/count/',
            '/api/tokenizers/unknown/count', '/api/tokenizers/remote/kobold/count',
            '/api/tokenizers/remote/textgenerationwebui/encode',
            '/api/tokenizers/openai/generate', '/api/tokenizers/openai/%63ount',
            '/api/tokenizers/openai//count', '/API/tokenizers/openai/count',
            '/generate?next=/api/worldinfo/get', '/api/tokenizers/openai/count%2Fgenerate',
        ]) assert.throws(() => host.fetch(path), safeError);
        assert.equal(calls.fetch.length, 8);
    } finally { guard.restore(); }
});

test('unknown, backend, settings/chat writes and external URLs fail closed with safe records', () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    const urls = [
        '/api/backends/text-completions/generate?key=secret', '/generate?token=secret',
        '/api/settings/save?token=secret', '/api/settings/get', '/api/chats/save', '/unknown',
        'https://remote.test/api/worldinfo/get?key=secret',
        '//remote.test/api/tokenizers/openai/count?key=secret',
        'https://tavern.test.evil.test/api/worldinfo/get',
        'http://tavern.test/api/worldinfo/get', 'https://tavern.test:444/api/worldinfo/get',
        'data:text/plain,secret', 'http://[invalid?secret',
    ];
    try {
        for (const url of urls) assert.throws(() => host.fetch(url, { body: 'private' }), safeError);
        assert.deepEqual(guard.blocked, [
            '/api/backends/text-completions/generate', '/generate', '/api/settings/save',
            '/api/settings/get', '/api/chats/save', '/unknown', ...Array(7).fill('<external>'),
        ]);
        assert.equal(calls.fetch.length, 0);
        assert.equal(JSON.stringify(guard.blocked).includes('secret'), false);
    } finally { guard.restore(); }
});

test('allowed path cannot use write methods or override a Request method', () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    try {
        for (const method of ['DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
            assert.throws(() => host.fetch('/api/worldinfo/get', { method }), safeError);
        }
        const request = new Request(`${origin}/api/worldinfo/get`, { method: 'POST' });
        assert.throws(() => host.fetch(request, { method: 'DELETE' }), safeError);
        assert.throws(() => host.fetch(`https://user:password@tavern.test/api/worldinfo/get`), safeError);
        assert.equal(calls.fetch.length, 0);
    } finally { guard.restore(); }
});

test('XHR open records method and URL; blocked send never calls native send', () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    try {
        const xhr = new host.XMLHttpRequest();
        xhr.open('POST', '/api/backends/chat-completions/generate?key=secret', false);
        assert.equal(calls.open.length, 1);
        assert.throws(() => xhr.send('private payload'), safeError);
        xhr.open('POST', 'https://remote.test/api/worldinfo/get?key=secret');
        assert.throws(() => xhr.send(), safeError);
        xhr.open('POST', '/api/tokenizers/remote/kobold/count');
        assert.throws(() => xhr.send(), safeError);
        xhr.open('DELETE', '/api/characters/get');
        assert.throws(() => xhr.send(), safeError);
        assert.throws(() => new host.XMLHttpRequest().send(), safeError);
        assert.equal(calls.send.length, 0);
        assert.deepEqual(guard.blocked, [
            '/api/backends/chat-completions/generate', '<external>',
            '/api/tokenizers/remote/kobold/count', '/api/characters/get', '<external>',
        ]);
    } finally { guard.restore(); }
});

test('XHR local read/token operations retain receiver and arguments', () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    const payload = {};
    try {
        const xhr = new host.XMLHttpRequest();
        for (const path of ['/api/worldinfo/get', '/api/characters/get', '/api/tokenizers/openai/count?model=gpt-4', '/api/tokenizers/llama/encode', '/api/tokenizers/llama/decode']) {
            xhr.open('POST', new URL(path, origin), false);
            xhr.send(payload);
        }
        assert.equal(calls.send.length, 5);
        assert.equal(calls.send[0].receiver, xhr);
        assert.equal(calls.send[0].args[0], payload);
        assert.equal(calls.open[0].args[2], false);
    } finally { guard.restore(); }
});

test('XHR opened before guard installation is blocked until re-opened', () => {
    const { host, calls } = mockHost();
    const xhr = new host.XMLHttpRequest();
    xhr.open('POST', '/generate');
    const guard = installPreviewGuard(host);
    try {
        assert.throws(() => xhr.send(), safeError);
        assert.equal(calls.send.length, 0);
    } finally { guard.restore(); }
});

test('WebSocket construction is blocked; native prototype and constants survive', () => {
    const { host, calls } = mockHost();
    const NativeWebSocket = host.WebSocket;
    const existing = new host.WebSocket('wss://tavern.test/existing');
    const guard = installPreviewGuard(host);
    try {
        assert.equal(host.WebSocket.prototype, NativeWebSocket.prototype);
        assert.equal(existing instanceof host.WebSocket, true);
        for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) assert.equal(host.WebSocket[key], NativeWebSocket[key]);
        assert.throws(() => new host.WebSocket('wss://tavern.test/generate?secret=private'), safeError);
        assert.throws(() => new host.WebSocket('wss://remote.test/socket?secret=private'), safeError);
        assert.throws(() => new host.WebSocket('wss://tavern.test/api/worldinfo/get'), safeError);
        assert.deepEqual(guard.blocked, ['/generate', '<external>', '/api/worldinfo/get']);
        assert.equal(calls.sockets.length, 1);
    } finally { guard.restore(); }
    assert.equal(host.WebSocket, NativeWebSocket);
});

test('restore does not clobber later fetch, XHR or WebSocket patches', async () => {
    const { host, calls } = mockHost();
    const guard = installPreviewGuard(host);
    const guardedFetch = host.fetch;
    const guardedSend = host.XMLHttpRequest.prototype.send;
    const guardedOpen = host.XMLHttpRequest.prototype.open;
    const GuardedSocket = host.WebSocket;
    const otherFetch = (...args) => guardedFetch(...args);
    const otherOpen = function (...args) { return guardedOpen.apply(this, args); };
    const otherSend = function (...args) { return guardedSend.apply(this, args); };
    class OtherSocket extends GuardedSocket {}
    host.fetch = otherFetch;
    host.XMLHttpRequest.prototype.open = otherOpen;
    host.XMLHttpRequest.prototype.send = otherSend;
    host.WebSocket = OtherSocket;
    guard.restore();
    assert.equal(host.fetch, otherFetch);
    assert.equal(host.XMLHttpRequest.prototype.open, otherOpen);
    assert.equal(host.XMLHttpRequest.prototype.send, otherSend);
    assert.equal(host.WebSocket, OtherSocket);
    // Our retained wrappers must be inert after restore, even underneath patches.
    await host.fetch('/generate');
    const xhr = new host.XMLHttpRequest();
    xhr.open('POST', '/generate');
    xhr.send();
    new host.WebSocket('wss://remote.test/generate');
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.sockets.length, 1);
    assert.deepEqual(guard.blocked, []);
});

test('active duplicate rejected; restore is idempotent and permits reinstall', () => {
    const { host } = mockHost();
    const guard = installPreviewGuard(host);
    const wrapper = host.fetch;
    assert.throws(() => installPreviewGuard(host), /already active/);
    assert.equal(host.fetch, wrapper);
    guard.restore();
    guard.restore();
    const second = installPreviewGuard(host);
    guard.restore(); // Old handle must not restore the newer installation.
    assert.throws(() => host.fetch('/generate'), safeError);
    assert.deepEqual(second.blocked, ['/generate']);
    second.restore();
});

test('failed installation rolls back earlier patches and fails with a safe error', () => {
    const { host } = mockHost();
    const nativeFetch = host.fetch;
    const nativeOpen = host.XMLHttpRequest.prototype.open;
    Object.defineProperty(host.XMLHttpRequest.prototype, 'send', { writable: false, configurable: false });
    assert.throws(() => installPreviewGuard(host), { message: 'Preview network guard could not be installed' });
    assert.equal(host.fetch, nativeFetch);
    assert.equal(host.XMLHttpRequest.prototype.open, nativeOpen);
});

test('invalid origin is rejected safely before anything is patched', () => {
    const { host } = mockHost();
    const native = host.fetch;
    assert.throws(() => installPreviewGuard(host, { origin: 'private invalid origin' }), {
        message: 'Preview network guard requires a valid HTTP origin',
    });
    assert.equal(host.fetch, native);
});
