// Free request preview based on the same mechanism as SillyTavern's Prompt Inspector and
// 酒馆助手's 提示词查看器: run a *real* generation so the whole pipeline executes (textarea
// consumption, world book activation, macros, prompt templates, other plugins), capture the
// final payload when CHAT_COMPLETION_SETTINGS_READY fires (before the request is issued), then
// abort the generation so no API request leaves the browser.
//
// Because the pipeline really runs, the captured payload is exact instead of approximated.
// The cost: the typed input is written into the chat as a normal user message, exactly like
// pressing Send. This module never fabricates a payload and never sends a request itself.

export function chatKey(ctx) {
    return JSON.stringify([ctx.characterId ?? null, ctx.groupId ?? null, ctx.chatId ?? ctx.getCurrentChatId?.() ?? null]);
}

/** Keep only comparable request fields; never retain headers, keys or proxy credentials. */
export function selectPayload(completion) {
    if (!completion || !Array.isArray(completion.messages)) throw new Error('未取得可比较的消息列表');
    const payload = {
        messages: structuredClone(completion.messages),
        model: completion.model ?? null,
        source: completion.chat_completion_source ?? null,
    };
    for (const key of ['tools', 'tool_choice', 'json_schema']) {
        if (completion[key] !== undefined) payload[key] = structuredClone(completion[key]);
    }
    return payload;
}

export function createExactCapture({ getContext, isGenerating = () => false, stopGeneration, timeoutMs = 15000, now = () => new Date().toISOString() }) {
    if (typeof getContext !== 'function') throw new TypeError('getContext 必须是函数');
    const ctx = getContext();
    const readyEvent = ctx?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY;
    if (!readyEvent || typeof ctx.eventSource?.on !== 'function') throw new Error('当前酒馆版本缺少请求捕获事件，无法精确捕获。');
    if (typeof stopGeneration !== 'function') throw new Error('当前酒馆版本缺少取消生成接口。');

    let last = null;
    let pending = null;
    let disposed = false;
    let wroteMessage = false;

    function onReady(completion) {
        if (disposed) return;
        if (pending) {
            const current = pending;
            pending = null;
            // Abort synchronously inside the listener: the awaited emit returns before
            // fetch() is called, so the aborted signal prevents the network request.
            try { stopGeneration(); } catch (error) { console.warn('[WorldBook Opt] 取消虚假生成失败', error); }
            let payload;
            try { payload = selectPayload(completion); }
            catch (error) { current.reject(error); return; }
            current.resolve(payload);
            return;
        }
        try {
            const payload = selectPayload(completion);
            last = { ...payload, key: chatKey(ctx), sentAt: now(), text: '真实请求（已由酒馆发出）' };
        } catch { /* observational only */ }
    }

    ctx.eventSource.on(readyEvent, onReady);

    function getLast() {
        if (!last) return null;
        return last.key === chatKey(ctx) ? structuredClone(last) : null;
    }

    return {
        getLast,
        isBusy() { return pending !== null; },
        wroteChatMessage() { return wroteMessage; },
        clear() { last = null; wroteMessage = false; },
        destroy() {
            disposed = true;
            try { ctx.eventSource.removeListener?.(readyEvent, onReady); } catch { /* ignore */ }
            last = null;
            pending = null;
        },
        /** Remove the user message this capture added, only when it is provably still the last one. */
        async undoWrittenMessage() {
            if (!wroteMessage) throw new Error('没有需要撤回的消息。');
            const chat = ctx.chat;
            const lastMessage = Array.isArray(chat) ? chat.at(-1) : null;
            if (!lastMessage || lastMessage.is_user !== true) throw new Error('聊天已变化，未撤回任何消息。');
            if (typeof ctx.deleteLastMessage !== 'function') throw new Error('当前酒馆版本不支持撤回消息。');
            await ctx.deleteLastMessage();
            wroteMessage = false;
        },
        /** Trigger a real generation, capture its payload, and abort it. No API request is sent. */
        async captureCurrent() {
            if (disposed) throw new Error('捕获器已销毁。');
            if (pending) throw new Error('已有一次捕获正在进行。');
            if (isGenerating()) throw new Error('酒馆正在生成，请等待完成后再捕获。');
            if (ctx.mainApi !== 'openai') throw new Error('本版仅支持聊天补全（Chat Completion）接口。');
            if (ctx.groupId != null && ctx.groupId !== '') throw new Error('本版不模拟群聊。');
            if (!Array.isArray(ctx.chat) || ctx.characterId == null) throw new Error('请先打开单人角色聊天。');

            const key = chatKey(ctx);
            const lengthBefore = ctx.chat.length;
            const payload = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (pending?.resolve === settle.resolve) {
                        pending = null;
                        reject(new Error('等待酒馆组装请求超时，未取得提示词。'));
                    }
                }, timeoutMs);
                const settle = {
                    resolve: value => { clearTimeout(timer); resolve(value); },
                    reject: error => { clearTimeout(timer); reject(error); },
                };
                pending = settle;
                let started;
                try { started = ctx.generate('normal'); }
                catch (error) { clearTimeout(timer); pending = null; reject(error); return; }
                // Aborting the capture rejects this promise; that is the expected outcome.
                Promise.resolve(started).catch(() => { /* aborted on purpose */ });
            });

            if (chatKey(ctx) !== key) throw new Error('聊天已切换，捕获结果已丢弃。');
            wroteMessage = ctx.chat.length > lengthBefore;
            return {
                previous: getLast(),
                current: { ...payload, key, capturedAt: now() },
                wroteMessage,
                warnings: [
                    '这是基于酒馆“提示词查看器”的精确捕获：输入框内容已作为一条用户消息写入聊天，随后取消了 AI 请求。',
                    '提示词后处理（酒馆后端对上下文的最终改写）发生在后端，浏览器无法看到，因此捕获的不是提供商最终收到的报文。',
                    '字符前缀按规范化 JSON 比较，不代表 token 前缀或真实 API 缓存命中率。',
                ],
            };
        },
    };
}

/** Native wiring: import SillyTavern modules and expose the capture runtime. */
export async function installExactCapture() {
    const core = await import('/script.js');
    const { getContext } = await import('/scripts/extensions.js');
    return createExactCapture({
        getContext,
        isGenerating: () => Boolean(core.isGenerating?.()),
        stopGeneration: core.stopGeneration,
    });
}
