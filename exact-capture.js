// Observe/capture the final browser -> SillyTavern JSON transport, NOT a prompt-ready event.
// All awaited SETTINGS_READY listeners (including squash/unwrapping) finish before this point.
// Preview runs the normal ST assembly pipeline, but this wrapper never forwards its model call.
// Normal ST generation may persist a user message/run macros; this is not a pure simulation.
const runtimes = new WeakMap();
const ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_BODY_CHARS = 16 * 1024 * 1024;
export function chatKey(ctx) {
    return JSON.stringify([ctx?.characterId ?? null, ctx?.groupId ?? null, ctx?.chatId ?? ctx?.getCurrentChatId?.() ?? null]);
}
export function selectPayload(body) {
    if (!body || !Array.isArray(body.messages)) throw new Error('最终请求没有可比较的 messages 数组。');
    const output = { messages: structuredClone(body.messages), model: body.model ?? null, source: body.chat_completion_source ?? null };
    for (const key of ['tools', 'tool_choice', 'json_schema']) if (body[key] !== undefined) output[key] = structuredClone(body[key]);
    return output; // Never retain headers, proxy_password, custom URLs, or the complete body.
}
function abortError(message) {
    const error = new Error(message); error.name = 'AbortError'; return error;
}
function messageSignature(message) { return JSON.stringify([message?.is_user, message?.name, message?.mes, message?.send_date]); }
function modelRoute(path) { return /(?:^|\/)(?:generate|chat\/completions|completions|responses|messages)(?:\/|$)/i.test(path); }
async function readBody(input, options) {
    let text;
    if (typeof options?.body === 'string') text = options.body;
    else if (options?.body !== undefined) throw new Error('请求正文不是 JSON 文本，不能安全捕获。');
    else if (typeof input?.clone === 'function') text = await input.clone().text();
    else throw new Error('缺少最终请求正文。');
    if (text.length > MAX_BODY_CHARS) throw new Error('请求正文过大，不能安全捕获。');
    return JSON.parse(text);
}

export function createExactCapture({ getContext, host = globalThis, isGenerating = () => false, stopGeneration,
    timeoutMs = 60000, now = () => new Date().toISOString(), getInput = () => host.document?.getElementById('send_textarea')?.value ?? '',
    hasAttachment = () => false } = {}) {
    if (runtimes.has(host)) return runtimes.get(host);
    if (typeof getContext !== 'function' || typeof host.fetch !== 'function' || !host.location?.origin) throw new Error('当前环境缺少标准 fetch 请求捕获接口。');
    if (typeof stopGeneration !== 'function') throw new Error('当前环境缺少停止生成接口。');
    let last = null, preview = null, undo = null, disabled = false, sequence = 0, newestAck = 0;
    let topWrapper = null, topDelegate = null;
    const stop = session => {
        if (session.stopped) return;
        session.stopped = true;
        try { stopGeneration(); } catch { /* Transport denial is independent of stopGeneration. */ }
    };
    const rejectSession = (session, error) => {
        if (!session.error) session.error = error;
        if (!session.callerSettled) { session.callerSettled = true; session.reject(session.error); }
    };
    const rememberUndo = session => {
        const ctx = getContext();
        if (chatKey(ctx) !== session.key || ctx.chat !== session.chat || ctx.chat.length !== session.length + 1) return false;
        const message = ctx.chat.at(-1);
        if (!message?.is_user || session.oldMessages.has(message)) return false;
        undo = { key: session.key, chat: ctx.chat, message, signature: messageSignature(message) };
        return true;
    };
    const removePatches = () => {
        if (host.fetch === topWrapper) host.fetch = topDelegate;
        // Retained wrapper references become inert; don't overwrite another extension's patch.
        runtimes.delete(host);
    };
    function installTopWrapper() {
        if (host.fetch === topWrapper) return;
        const delegate = host.fetch;
        const wrapper = async function(input, options) {
            if (disabled && !preview) return delegate.call(host, input, options);
            let url;
            try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input), host.location.origin); }
            catch { if (preview) { stop(preview); rejectSession(preview, new Error('预览阻止了未知网络请求。')); throw abortError('Preview network request blocked'); } return delegate.call(host,input,options); }
            const sameOrigin = url.origin === host.location.origin;
            const method = String(options?.method ?? input?.method ?? 'GET').toUpperCase();
            const primary = sameOrigin && url.pathname === ENDPOINT && method === 'POST';
            // Freeze attribution before any asynchronous Request.clone().text() read.
            const dispatchKey = primary ? chatKey(getContext()) : null;
            const sentAt = primary ? now() : null;
            const attemptId = primary ? ++sequence : null;
            const session = preview;
            if (session && primary) {
                try {
                    const body = await readBody(input, options);
                    if (body.type && body.type !== 'normal') throw new Error('预览期间检测到辅助/非普通生成请求，已阻止，不把它当作当前输入。');
                    if (chatKey(getContext()) !== session.key) throw new Error('聊天已切换，已阻止预览请求并丢弃结果。');
                    if (session.packet) throw new Error('同一次预览出现多个模型请求，不能确认唯一结果。');
                    session.packet = selectPayload(body);
                    session.capturedAt = now();
                    rememberUndo(session);
                } catch (error) { rejectSession(session, error); }
                // Fail closed even on timeout, parser failure, abort already set, or disposal.
                stop(session);
                throw abortError('WorldBook Opt intercepted preview before transport');
            }
            if (session && (!sameOrigin || modelRoute(url.pathname))) {
                rejectSession(session, new Error('预览阻止了额外模型或外部网络请求，不能给出可靠结果。'));
                stop(session); throw abortError('Extra preview network request blocked');
            }
            let candidate = null;
            if (!session && !disabled && primary && !(options?.signal ?? input?.signal)?.aborted) {
                try {
                    const body = await readBody(input,options);
                    if (body.type !== 'quiet' && body.type !== 'impersonate') candidate = { ...selectPayload(body), key: dispatchKey, sentAt, id: attemptId };
                } catch { /* Ordinary requests must not break because diagnostics cannot parse them. */ }
            }
            const response = await delegate.call(host,input,options);
            // A ready event is not a send. Only an actual transport with a successful ST response
            // establishes the baseline; streaming completion/upstream billing is NOT inferred.
            if (!disabled && candidate && response.ok && !(options?.signal ?? input?.signal)?.aborted && candidate.id > newestAck) {
                newestAck = candidate.id;
                last = { ...candidate, status: `酒馆后端已响应 HTTP ${response.status}` };
            }
            return response;
        };
        topDelegate = delegate; topWrapper = wrapper; host.fetch = wrapper;
    }
    installTopWrapper();
    const runtime = {
        getLast() { return last?.key === chatKey(getContext()) ? structuredClone(last) : null; },
        isBusy() { return preview !== null; },
        wroteChatMessage() { return Boolean(undo); },
        clear() { last = null; newestAck = ++sequence; /* Keep undo so clearing history cannot orphan safe recovery. */ },
        destroy() {
            if (disabled) return;
            disabled = true; last = null;
            if (preview) { rejectSession(preview,new Error('捕获器已关闭，预览已停止。')); stop(preview); }
            else removePatches();
        },
        async undoWrittenMessage() {
            if (preview || isGenerating()) throw new Error('生成流程尚未结束，暂不能撤回。');
            if (!undo) throw new Error('没有可安全撤回的预览消息。');
            const ctx = getContext();
            if (chatKey(ctx) !== undo.key || ctx.chat !== undo.chat || ctx.chat.at(-1) !== undo.message || messageSignature(undo.message) !== undo.signature) throw new Error('聊天或末条消息已变化，未删除任何消息。');
            const index = ctx.chat.length - 1;
            if (typeof ctx.deleteMessage === 'function') {
                // Native deleteMessage persists changes; deleteLastMessage alone does not save.
                await ctx.deleteMessage(index, undefined, false, false);
            } else {
                if (typeof ctx.deleteLastMessage !== 'function' || typeof ctx.saveChat !== 'function') throw new Error('酒馆缺少可保存的安全撤回接口，未删除消息。');
                await ctx.deleteLastMessage();
                if (chatKey(getContext()) !== undo.key || getContext().chat !== undo.chat) throw new Error('聊天已切换，撤回后的保存未执行。');
                await ctx.saveChat();
            }
            undo = null;
        },
        captureCurrent() {
            if (disabled) return Promise.reject(new Error('捕获器已关闭。'));
            if (preview || isGenerating()) return Promise.reject(new Error('正在生成/预览，请等待流程结束。'));
            const ctx = getContext();
            if (ctx.mainApi !== 'openai') return Promise.reject(new Error('仅支持标准 Chat Completion fetch 接口。'));
            if (ctx.groupId != null && ctx.groupId !== '') return Promise.reject(new Error('本版不捕获群聊。'));
            if (ctx.characterId == null || !Array.isArray(ctx.chat)) return Promise.reject(new Error('请先打开单人角色聊天。'));
            if (typeof ctx.generate !== 'function') return Promise.reject(new Error('缺少酒馆生成接口。'));
            if (String(getInput()).trimStart().startsWith('/')) return Promise.reject(new Error('预览不执行斜杠命令，请输入普通文本。'));
            if (hasAttachment()) return Promise.reject(new Error('预览不上传新附件，请先移除待发送附件。'));
            installTopWrapper(); // Remain outermost if another extension changed fetch after startup.
            const session = { key: chatKey(ctx), chat: ctx.chat, length: ctx.chat.length, oldMessages: new Set(ctx.chat),
                previous: runtime.getLast(), packet: null, callerSettled: false, stopped: false, error: null };
            preview = session;
            return new Promise((resolve,reject) => {
                session.resolve=resolve;session.reject=reject;
                const timer = setTimeout(() => {
                    rejectSession(session,new Error('预览超时，已停止生成；请求拦截会保留到该流程结束，迟到请求也不会发送。'));
                    stop(session);
                    // Crucially do not clear preview here. A late SETTINGS_READY/fetch stays blocked.
                },timeoutMs);
                const finish = error => {
                    clearTimeout(timer);
                    const wroteMessage = rememberUndo(session);
                    if (preview === session) preview = null;
                    if (disabled) removePatches();
                    if (session.callerSettled) return;
                    if (session.error || !session.packet || chatKey(getContext()) !== session.key) {
                        rejectSession(session,session.error ?? new Error(error?.name !== 'AbortError' && error?.message ? error.message : '酒馆流程已结束，但未到达支持的最终请求发送边界。'));
                        return;
                    }
                    session.callerSettled=true;
                    resolve({ previous:session.previous,current:{...session.packet,key:session.key,capturedAt:session.capturedAt},wroteMessage,
                        warnings:[
                            '捕获点是最终浏览器→酒馆的 fetch JSON；已等待提示词事件的全部监听器处理完毕，预览模型请求未转发。',
                            '正常组装会运行宏/插件，并可能将输入写入聊天；撤回只删除身份核验通过的那条消息，不能回滚所有插件副作用。',
                            '酒馆后端/提供商仍可能改写报文；字符前缀不是 token 数或实际 API 缓存命中率。',
                        ] });
                };
                // Promise.resolve().then catches both a synchronous throw and asynchronous reject.
                // Let ST allocate a fresh generation controller. Supplying an external signal
                // can make some ST versions reuse an already-aborted previous controller.
                Promise.resolve().then(() => ctx.generate('normal')).then(()=>finish(),finish);
            });
        },
    };
    runtimes.set(host,runtime);return runtime;
}
export async function installExactCapture() {
    if (runtimes.has(globalThis)) return runtimes.get(globalThis);
    // Native/alternate transports bypassing window.fetch are not supported; don't promise isolation.
    if (globalThis.__TAURI__ || globalThis.__TAURI_INTERNALS__) throw new Error('此原生传输环境不支持发送边界预览，请使用标准浏览器酒馆。');
    const core = await import('/script.js');
    const {getContext} = await import('/scripts/extensions.js');
    const {hasPendingFileAttachment} = await import('/scripts/chats.js');
    return createExactCapture({getContext,isGenerating:()=>Boolean(core.isGenerating?.()),stopGeneration:core.stopGeneration,hasAttachment:hasPendingFileAttachment});
}
