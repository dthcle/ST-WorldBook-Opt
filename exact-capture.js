// Observe/capture the final browser -> SillyTavern JSON transport, NOT a prompt-ready event.
// All awaited SETTINGS_READY listeners (including squash/unwrapping) finish before this point.
// New UI uses native dry-run (third Generate argument), never the old ordinary-send preview.
// Dry-run snapshots are explicitly NOT the final transport: several ordinary handlers are skipped.
// Legacy captureCurrent remains an internal compatibility API; it may persist a user message.
import { replaySnapshot, useReplayChat, useRecordCopies } from './request-snapshot.js';
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
    hasAttachment = () => false, dryRunGenerate, getModel = () => getContext()?.getChatCompletionModel?.() ?? null,
    getSource = () => getContext()?.chatCompletionSettings?.chat_completion_source ?? null, getPromptError = () => null } = {}) {
    if (runtimes.has(host)) return runtimes.get(host);
    if (typeof getContext !== 'function' || typeof host.fetch !== 'function' || !host.location?.origin) throw new Error('当前环境缺少标准 fetch 请求捕获接口。');
    if (typeof stopGeneration !== 'function') throw new Error('当前环境缺少停止生成接口。');
    let last = null, replay = null, simulationBase = null, preview = null, undo = null, disabled = false, sequence = 0, newestAck = 0;
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
            const dispatchContext = primary ? getContext() : null;
            const dispatchKey = primary ? chatKey(dispatchContext) : null;
            const dispatchReplay = primary && !preview && dispatchContext?.chat?.at(-1)?.is_user ? replaySnapshot(dispatchContext) : null;
            const sentAt = primary ? now() : null;
            const attemptId = primary ? ++sequence : null;
            const session = preview;
            if (session?.dryRun && primary) {
                rejectSession(session, new Error('酒馆模拟意外尝试调用模型，已阻止；没有退回普通发送。'));
                stop(session); throw abortError('Dry run attempted model transport');
            }
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
            if (session?.dryRun && sameOrigin && (/^\/api\/tokenizers\/remote\//.test(url.pathname) || (method !== 'GET' && !/^\/api\/(?:tokenizers\/|worldinfo\/get$)/.test(url.pathname)))) {
                rejectSession(session, new Error('模拟阻止了写入或不支持的本地请求：' + url.pathname));
                stop(session); throw abortError('Dry run write request blocked');
            }
            if (session && (!sameOrigin || modelRoute(url.pathname))) {
                rejectSession(session, new Error('预览阻止了额外模型或外部网络请求，不能给出可靠结果。'));
                stop(session); throw abortError('Extra preview network request blocked');
            }
            let candidate = null;
            if (!session && !disabled && primary && !(options?.signal ?? input?.signal)?.aborted) {
                try {
                    const body = await readBody(input,options);
                    if (body.type !== 'quiet' && body.type !== 'impersonate') candidate = { ...selectPayload(body), key: dispatchKey, sentAt, id: attemptId, generationType: body.type ?? 'normal' };
                } catch { /* Ordinary requests must not break because diagnostics cannot parse them. */ }
            }
            const response = await delegate.call(host,input,options);
            // A ready event is not a send. Only an actual transport with a successful ST response
            // establishes the baseline; streaming completion/upstream billing is NOT inferred.
            if (!disabled && candidate && response.ok && !(options?.signal ?? input?.signal)?.aborted && candidate.id > newestAck) {
                newestAck = candidate.id;
                last = { ...candidate, kind: 'actual', status: `酒馆后端已响应 HTTP ${response.status}` };
                replay = candidate.generationType === 'normal' ? dispatchReplay : null;
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
        getSimulationBase() { return simulationBase?.key === chatKey(getContext()) ? structuredClone(simulationBase) : null; },
        setSimulationBase(packet) {
            if (preview || isGenerating()) throw new Error('请等待模拟结束。');
            if (packet?.kind !== 'simulation' || packet.key !== chatKey(getContext())) throw new Error('只能使用当前聊天的模拟结果作为模拟基准。');
            simulationBase = { ...selectPayload({ ...packet, chat_completion_source: packet.source }), key: packet.key, kind: 'simulation', capturedAt: packet.capturedAt };
        },
        clear() { last = null; replay = null; simulationBase = null; newestAck = ++sequence; /* Preserve legacy safe recovery. */ },
        simulate({ mode = 'empty' } = {}) {
            if (disabled) return Promise.reject(new Error('捕获器已关闭。'));
            if (preview || isGenerating()) return Promise.reject(new Error('正在生成/预览，请等待流程结束。'));
            const ctx = getContext();
            if (ctx.mainApi !== 'openai') return Promise.reject(new Error('仅支持标准 Chat Completion 提示词模拟。'));
            if (ctx.groupId != null && ctx.groupId !== '') return Promise.reject(new Error('本版不模拟群聊。'));
            if (ctx.characterId == null || !Array.isArray(ctx.chat)) return Promise.reject(new Error('请先打开单人角色聊天。'));
            if (!['empty', 'replay'].includes(mode)) return Promise.reject(new Error('未知模拟方式。'));
            const event = ctx.eventTypes?.GENERATE_AFTER_DATA;
            if (typeof dryRunGenerate !== 'function' || !event || typeof ctx.eventSource?.on !== 'function' || typeof ctx.eventSource?.removeListener !== 'function') {
                return Promise.reject(new Error('当前酒馆缺少已验证的 dry-run 接口；不会退回普通发送。'));
            }
            const previous = runtime.getLast() ?? runtime.getSimulationBase();
            if (mode === 'replay' && (!runtime.getLast() || !replay)) return Promise.reject(new Error('暂无上次用户发送快照，请先用空文本模拟；不会自动发送请求。'));
            // Empty means append nothing: ST dry-run ignores the composer and send_if_empty.
            // Even empty mode works on copies, because ST substitutes the first greeting in-place.
            const snapshot = mode === 'replay' ? replay : { chat: ctx.chat };
            let restore, restoreMetadata = () => {}, restorePrompts = () => {};
            try {
                restore = useReplayChat(ctx.chat, snapshot);
                restoreMetadata = useRecordCopies(ctx.chatMetadata);
                restorePrompts = useRecordCopies(ctx.extensionPrompts);
            } catch (error) { restore?.(); restoreMetadata(); return Promise.reject(error); }
            installTopWrapper();
            const session = { dryRun: true, key: chatKey(ctx), chat: ctx.chat, previous, packet: null, data: null,
                callerSettled: false, stopped: false, error: null, received: false };
            preview = session;
            return new Promise((resolve, reject) => {
                session.reject = reject;
                const listener = (data, dryRun) => {
                    if (dryRun !== true || chatKey(getContext()) !== session.key || getContext().chat !== session.chat) {
                        rejectSession(session, new Error('模拟流程或聊天身份发生变化，结果已丢弃。')); return;
                    }
                    if (session.received) { rejectSession(session, new Error('同一次模拟出现多个组装结果，无法确认。')); return; }
                    session.received = true;
                    session.data = data; // Do NOT clone in a listener: later awaited plugins still mutate it.
                };
                ctx.eventSource.on(event, listener);
                const timer = setTimeout(() => {
                    rejectSession(session, new Error('模拟超时，拦截会保留到组装结束；没有发送模型请求。'));
                    stop(session);
                }, timeoutMs);
                const finish = error => {
                    clearTimeout(timer);
                    ctx.eventSource.removeListener(event, listener);
                    // ST may reuse the same exported array when switching chats. Never overwrite
                    // that newly loaded chat; restore a detached old array or the unchanged chat only.
                    const after = getContext();
                    if (chatKey(after) === session.key || after.chat !== session.chat) restore();
                    if (chatKey(after) === session.key || after.chatMetadata !== ctx.chatMetadata) restoreMetadata();
                    if (chatKey(after) === session.key || after.extensionPrompts !== ctx.extensionPrompts) restorePrompts();
                    if (preview === session) preview = null;
                    if (disabled) removePatches();
                    if (session.callerSettled) return;
                    try {
                        if (session.error) throw session.error;
                        if (error) throw error;
                        if (getPromptError()) throw new Error('酒馆提示词组装出错：' + getPromptError());
                        if (chatKey(getContext()) !== session.key || getContext().chat !== session.chat) throw new Error('聊天已切换，模拟结果已丢弃。');
                        if (!session.data || !Array.isArray(session.data.prompt) || !session.data.prompt.length) throw new Error('酒馆未产出有效的 dry-run 消息列表；没有退回普通发送。');
                        const current = { ...selectPayload({ messages: session.data.prompt, model: getModel(), chat_completion_source: getSource() }),
                            key: session.key, kind: 'simulation', mode, capturedAt: now() };
                        session.callerSettled = true;
                        resolve({ previous, current, wroteMessage: false, warnings: [
                            '这是 dry-run 提示词快照：不读取输入框，不追加空用户消息，不调用模型；聊天原消息对象已恢复。',
                            mode === 'replay' ? '重放的是上次请求时截至最后一条用户消息的历史快照，不包含随后生成的回复。' : '空文本模拟使用当前聊天历史，没有加入新文本；它不是实际发送一个空消息。',
                            'dry-run 不执行全部普通发送拦截器/SETTINGS_READY 后处理、系统消息合并；世界书粘附/冷却的判断也不同。与真实基准的差异可能包含这些流程差异，不保证等于最终 API 正文。',
                            '宏、世界书和第三方插件仍可能更新私有状态；标准写入 fetch 已阻止，但这不是任意第三方代码的安全沙箱。',
                        ] });
                    } catch (failure) { rejectSession(session, failure); }
                };
                // Critical: dryRun is Generate's THIRD positional argument in ST, not an options property.
                Promise.resolve().then(() => dryRunGenerate(ctx)).then(() => finish(), finish);
            });
        },
        destroy() {
            if (disabled) return;
            disabled = true; last = null; replay = null; simulationBase = null;
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
    const openai = await import('/scripts/openai.js');
    return createExactCapture({getContext,isGenerating:()=>Boolean(core.isGenerating?.()),stopGeneration:core.stopGeneration,hasAttachment:hasPendingFileAttachment,
        // Verified native signature: Generate(type, options, dryRun).
        dryRunGenerate: typeof core.Generate === 'function' ? () => core.Generate('normal', {}, true) : undefined,
        getModel: () => openai.getChatCompletionModel?.() ?? null,
        getSource: () => openai.oai_settings?.chat_completion_source ?? null,
        getPromptError: () => openai.promptManager?.error ?? null,
    });
}
