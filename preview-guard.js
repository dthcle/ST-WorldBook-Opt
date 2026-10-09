// Best-effort, host-local preview guard. It cannot stop existing sockets, workers,
// requests already in flight, or callers holding references to unpatched APIs.
// Install synchronously immediately before preview work, and restore in finally.
const activeGuards = new WeakMap();

// ST's local tokenizer routes (src/endpoints/tokenizers.js). In particular, do
// NOT allow /remote/kobold/count or /remote/textgenerationwebui/encode: those
// endpoints forward prompt text to a remote backend. Unknown routes fail closed.
const localTokenizers = [
    'llama', 'nerdstash', 'nerdstash_v2', 'mistral', 'yi', 'gemma', 'jamba',
    'gpt2', 'claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo',
    'deepseek', 'openai',
];
const allowedPaths = new Set([
    '/api/worldinfo/get', '/api/characters/get', '/api/tokenizers/openai/count',
    ...localTokenizers.flatMap(name => [
        `/api/tokenizers/${name}/encode`, `/api/tokenizers/${name}/decode`,
    ]),
]);

/**
 * Only GET/POST to the enumerated same-origin read endpoints are permitted.
 * blocked contains pathname strings or '<external>', never query/body/headers.
 * A second active installation on the same host throws rather than weakening
 * the first guard. This is not a security boundary against hostile JS.
 */
export function installPreviewGuard(host = globalThis, { origin = host.location?.origin ?? globalThis.location?.origin } = {}) {
    if (activeGuards.has(host)) throw new Error('Preview network guard is already active');
    let base;
    try {
        base = new URL(origin);
        if (!['http:', 'https:'].includes(base.protocol)) throw new Error();
        base = base.origin;
    } catch {
        throw new Error('Preview network guard requires a valid HTTP origin');
    }

    const blocked = [];
    const patches = [];
    const xhrRequests = new WeakMap();
    let active = true;

    function classify(input, socket = false) {
        try {
            // A Request's URL is sufficient; never clone/read its body or headers.
            const RequestType = host.Request ?? globalThis.Request;
            const value = RequestType && input instanceof RequestType ? input.url : input;
            const url = new URL(value, `${base}/`);
            const protocol = socket ? url.protocol.replace(/^ws/, 'http') : url.protocol;
            const sameOrigin = `${protocol}//${url.host}` === base;
            return {
                path: sameOrigin ? url.pathname : '<external>',
                allowed: sameOrigin && !url.username && !url.password && allowedPaths.has(url.pathname),
            };
        } catch {
            return { path: '<external>', allowed: false };
        }
    }

    function deny(path) {
        blocked.push(path);
        // No caller-controlled text in errors, including malformed URLs.
        const error = new Error('Network request blocked during prompt preview');
        error.name = 'PreviewNetworkBlockedError';
        throw error;
    }

    function permittedMethod(method) {
        return typeof method === 'string' && /^(GET|POST)$/i.test(method);
    }

    function patch(target, key, wrapper) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, descriptor && 'value' in descriptor
            ? { ...descriptor, value: wrapper }
            : { value: wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? true });
        patches.push({ target, key, descriptor, wrapper });
    }

    const guard = {
        blocked,
        restore() {
            if (!active) return;
            // Retained wrappers (e.g. another patch wrapping ours) become inert.
            active = false;
            activeGuards.delete(host);
            for (const { target, key, descriptor, wrapper } of patches.reverse()) {
                if (target[key] !== wrapper) continue;
                if (descriptor) Object.defineProperty(target, key, descriptor);
                else delete target[key];
            }
        },
    };

    try {
        if (typeof host.fetch === 'function') {
            const nativeFetch = host.fetch;
            patch(host, 'fetch', function previewFetch(input, init) {
                if (active) {
                    const route = classify(input);
                    const RequestType = host.Request ?? globalThis.Request;
                    const method = init?.method ?? (RequestType && input instanceof RequestType ? input.method : 'GET');
                    if (!route.allowed || !permittedMethod(method)) deny(route.path);
                }
                return Reflect.apply(nativeFetch, host, arguments);
            });
        }

        const xhrPrototype = host.XMLHttpRequest?.prototype;
        if (xhrPrototype) {
            const nativeOpen = xhrPrototype.open;
            const nativeSend = xhrPrototype.send;
            if (typeof nativeOpen !== 'function' || typeof nativeSend !== 'function') {
                throw new Error('Preview network guard could not protect XMLHttpRequest');
            }
            patch(xhrPrototype, 'open', function previewOpen(method, url) {
                if (active) {
                    // Reset before native open: a failed re-open cannot reuse a
                    // previously allowed request's classification.
                    xhrRequests.delete(this);
                    const route = classify(url);
                    const result = Reflect.apply(nativeOpen, this, arguments);
                    xhrRequests.set(this, { ...route, method });
                    return result;
                }
                return Reflect.apply(nativeOpen, this, arguments);
            });
            patch(xhrPrototype, 'send', function previewSend() {
                if (active) {
                    const route = xhrRequests.get(this);
                    if (!route?.allowed || !permittedMethod(route.method)) deny(route?.path ?? '<external>');
                }
                return Reflect.apply(nativeSend, this, arguments);
            });
        }

        if (typeof host.WebSocket === 'function') {
            const NativeWebSocket = host.WebSocket;
            function PreviewWebSocket(url) {
                if (active) deny(classify(url, true).path);
                return Reflect.construct(NativeWebSocket, Array.from(arguments),
                    new.target === PreviewWebSocket ? NativeWebSocket : new.target);
            }
            // Keep OPEN/CLOSED/etc. and instanceof/prototype compatibility.
            Object.setPrototypeOf(PreviewWebSocket, NativeWebSocket);
            PreviewWebSocket.prototype = NativeWebSocket.prototype;
            patch(host, 'WebSocket', PreviewWebSocket);
        }
        activeGuards.set(host, guard);
        return guard;
    } catch {
        guard.restore();
        throw new Error('Preview network guard could not be installed');
    }
}
