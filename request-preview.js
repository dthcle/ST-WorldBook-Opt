import { installPreviewGuard } from './preview-guard.js';

const clone = value => structuredClone(value);
export function chatKey(ctx) { return JSON.stringify([ctx.characterId ?? null, ctx.groupId ?? null, ctx.chatId ?? ctx.getCurrentChatId?.() ?? null]); }
export function selectRequestInput(body) {
    if (!body || !Array.isArray(body.messages)) throw new Error('不是可比较的聊天补全请求');
    const record = { messages: clone(body.messages), model: body.model ?? null, source: body.chat_completion_source ?? null };
    for (const key of ['tools', 'tool_choice', 'json_schema']) if (body[key] !== undefined) record[key] = clone(body[key]);
    return record; // Never retain headers, proxy_password, API URLs or the whole body.
}
/** Restore known JSON-like state in place, retaining existing array/object references. */
function rememberReferences(target,snapshot) {
    const refs=new Map(),stack=[[target,snapshot]];
    while(stack.length){const [original,copy]=stack.pop();if(!copy||typeof copy!=='object'||refs.has(copy))continue;refs.set(copy,original);for(const key of Object.keys(copy))if(copy[key]&&typeof copy[key]==='object')stack.push([original[key],copy[key]])}return refs;
}
export function restoreState(target, snapshot, references, visited = new WeakSet()) {
    if(visited.has(target))return;visited.add(target);
    if (Array.isArray(target) && Array.isArray(snapshot)) {
        for (let i = 0; i < snapshot.length; i++) {
            if(references?.has(snapshot[i])) target[i]=references.get(snapshot[i]);
            if (target[i] && snapshot[i] && typeof target[i] === 'object' && typeof snapshot[i] === 'object' && Array.isArray(target[i]) === Array.isArray(snapshot[i])) restoreState(target[i], snapshot[i], references, visited);
            else target[i] = clone(snapshot[i]);
        }
        target.length = snapshot.length;
    } else {
        for (const key of Object.keys(target)) if (!Object.hasOwn(snapshot, key)) delete target[key];
        for (const key of Object.keys(snapshot)) {
            if(references?.has(snapshot[key]))Object.defineProperty(target,key,{value:references.get(snapshot[key]),writable:true,enumerable:true,configurable:true});
            if (target[key] && snapshot[key] && typeof target[key] === 'object' && typeof snapshot[key] === 'object' && Array.isArray(target[key]) === Array.isArray(snapshot[key])) restoreState(target[key], snapshot[key], references, visited);
            else Object.defineProperty(target,key,{value:clone(snapshot[key]),writable:true,enumerable:true,configurable:true});
        }
    }
}
// Read-only native macro candidates. Unknown/custom or state-writing macros fail closed.
const SAFE_MACROS = new Set(('user char persona description personality scenario mesexamples examples system jailbreak name1 name2 original lastmessage lastusermessage lastcharmessage lastmessageid firstmessageid chatid charid input getvar getglobalvar time date weekday isotime isodate datetime idle_duration lastgenerationtype trim newline noop reverse version model maxprompt maxtokens context charversion char_version char_creator user_persona').split(' '));
export function assertPreviewTextSafe(value) {
    const stack = [value], seen = new WeakSet();
    while (stack.length) {
        const item = stack.pop();
        if (typeof item === 'string') {
            if (/<%|%>/.test(item)) throw new Error('存在 EJS 模板，本版不执行第三方模板脚本，无法安全模拟。');
            for (const match of item.matchAll(/\{\{\s*([^{}]*?)(?:\}\}|$)/g)) {
                const text = match[1].trim(); if (text.startsWith('//')) continue;
                const name = text.split(/::|\s|:/)[0].toLowerCase();
                if (!SAFE_MACROS.has(name)) throw new Error(`存在写入、随机或未知宏「${name.slice(0,48)}」，本版拒绝执行模拟。`);
            }
        } else if (item && typeof item === 'object' && !seen.has(item)) {seen.add(item);stack.push(...Object.values(item));}
    }
}
export function createRequestPreview({ getContext, host = globalThis, isGenerating = () => false, preprocess = text => text, activeBooks = async () => [], promptManager = () => null, hasAttachment = () => false }) {
    let last = null, previewing = false, observing = true;
    const originalFetch = host.fetch;
    async function observer(input, options) {
        let candidate = null;
        try {
            const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), host.location.origin);
            if (observing && !previewing && String(options?.method ?? input?.method ?? 'GET').toUpperCase() === 'POST' && url.origin === host.location.origin && url.pathname === '/api/backends/chat-completions/generate' && typeof options?.body === 'string') {
                const body = JSON.parse(options.body);
                if (options.body.length <= 16 * 1024 * 1024) candidate = { ...selectRequestInput(body), key: chatKey(getContext()), sentAt: new Date().toISOString(), status: '已调用发送接口' };
            }
        } catch { /* Observational only: never disrupt real generation. */ }
        if (candidate) last = candidate;
        try { const response = await originalFetch.call(host, input, options); if (candidate) candidate.status = response.ok ? `酒馆后端已响应 HTTP ${response.status}` : `酒馆后端错误 HTTP ${response.status}`; return response; }
        catch (error) { if (candidate) candidate.status = '发送失败 / 已取消，是否到达后端未知'; throw error; }
    }
    host.fetch = observer;
    return {
        getLast() { const ctx = getContext(); return last?.key === chatKey(ctx) ? clone(last) : null; },
        isPreviewing() { return previewing; },
        clear() { last = null; },
        destroy() { observing=false; if (host.fetch === observer) host.fetch = originalFetch; last = null; },
        async simulate(input, textarea) {
            if (previewing || isGenerating()) throw new Error('正在生成或预览，请等待完成。');
            const ctx = getContext(); const key = chatKey(ctx);
            if (!last || last.key !== key) throw new Error('当前聊天没有捕获到实际请求。安装并刷新后正常发送一次即可；不会为诊断自动发送。');
            if (ctx.mainApi !== 'openai') throw new Error('本版仅支持 Chat Completion（聊天补全）接口。');
            if (ctx.groupId != null && ctx.groupId !== '') throw new Error('本版不模拟群聊的发言角色选择。');
            if (!Array.isArray(ctx.chat) || ctx.characterId == null) throw new Error('请先打开单人角色聊天。');
            if (!input?.trim()) throw new Error('请先在用户输入框写入要预览的内容；空输入自动续写不在本版范围内。');
            if (input.trimStart().startsWith('/')) throw new Error('预览不会执行斜杠命令，请输入普通聊天文本。');
            if (hasAttachment()) throw new Error('检测到待发送附件，请先移除附件；本版仅模拟文本输入。');
            if (ctx.chatCompletionSettings?.squash_system_messages) throw new Error('当前开启了合并系统消息：酒馆 dry-run 不执行相同合并，本版拒绝给出误导性对比。');
            if (ctx.chatCompletionSettings?.function_calling) throw new Error('工具调用已启用，本版不执行第三方工具定义回调。');
            if (last.tools?.length || last.json_schema) throw new Error('上次请求包含工具或结构化输出，本版无法完整模拟这些输入字段。');
            const stateTargets = [ctx.chat, ctx.chatMetadata, ctx.extensionPrompts, ctx.extensionSettings].filter(x => x && typeof x === 'object');
            const snapshots = stateTargets.map(target => {const copy=clone(target);return [target,copy,rememberReferences(target,copy)]});
            const originalEmit = ctx.eventSource.emit;
            if (typeof ctx.generate !== 'function' || typeof originalEmit !== 'function' || !ctx.eventTypes?.GENERATE_AFTER_DATA) throw new Error('当前酒馆版本缺少可用的 dry-run 接口。');
            const manager = promptManager();
            const managerFields = manager ? Object.fromEntries(['messages','overriddenPrompts','tokenUsage','error'].map(k => [k,manager[k]])) : null;
            const counts = manager?.tokenHandler?.counts;
            const savedCounts = counts ? clone(counts) : null;
            const savedInput = textarea?.value; const savedReadOnly = textarea?.readOnly;
            let assembled = null, guard;
            const skipped = new Set(['GENERATION_STARTED','GENERATION_AFTER_COMMANDS','GENERATE_BEFORE_COMBINE_PROMPTS','GENERATE_AFTER_COMBINE_PROMPTS','CHAT_COMPLETION_PROMPT_READY','WORLDINFO_ENTRIES_LOADED','WORLDINFO_SCAN_DONE','WORLD_INFO_ACTIVATED','GENERATE_AFTER_DATA'].map(k=>ctx.eventTypes[k]).filter(Boolean));
            const warnings = ['这是受限模拟，不是保证与下一次真实请求完全一致的预言。', '跳过生成 / 世界书事件插件及生成拦截器；第三方记忆、向量、模板等贡献可能缺失。', '粘附、冷却、概率、随机与时间、后端提供商转换可能与真实发送不同。', '字符前缀按规范化 JSON 比较，不代表 token 前缀或真实 API 缓存命中率。'];
            const previewEmit = async function(event, ...args) {
                if (event === ctx.eventTypes.GENERATE_AFTER_DATA) assembled = args[0];
                if (skipped.has(event)) return;
                return originalEmit.call(this,event,...args);
            };
            previewing = true;
            try {
                guard = installPreviewGuard(host, { origin: host.location.origin });
                // Check sources without evaluating macros. No custom generation listeners run.
                assertPreviewTextSafe([input,ctx.chat,ctx.characters?.[ctx.characterId],ctx.extensionPrompts,ctx.chatCompletionSettings?.prompts,ctx.powerUserSettings]);
                const books = await activeBooks(ctx);
                assertPreviewTextSafe(books);
                if (chatKey(getContext()) !== key) throw new Error('聊天已切换，取消预览。');
                ctx.eventSource.emit = previewEmit;
                if (textarea) { textarea.readOnly = true; textarea.value = ''; }
                const text = preprocess(input);
                assertPreviewTextSafe(text);
                const prepared = ctx.substituteParams ? ctx.substituteParams(text) : text;
                ctx.chat.push({ name: ctx.name1, is_user: true, is_system: false, mes: prepared, send_date: new Date().toISOString(), extra: {} });
                await ctx.generate('normal', { signal: new AbortController().signal }, true);
                if (chatKey(getContext()) !== key) throw new Error('聊天已切换，取消预览。');
                if (guard.blocked.length) throw new Error(`预览尝试了不允许的网络操作，已阻止：${guard.blocked.join('、')}。无法给出完整结果。`);
                if (!Array.isArray(assembled?.prompt) || !assembled.prompt.length) throw new Error('酒馆未返回可比较的消息列表；可能版本不兼容或提示词组装失败。');
                const current = { messages: clone(assembled.prompt), model: ctx.getChatCompletionModel?.() ?? null, source: ctx.chatCompletionSettings?.chat_completion_source ?? null };
                return { previous: clone(last), current, warnings, generatedAt: new Date().toISOString() };
            } finally {
                // Restore original objects even if active context changed; never save/chat-render.
                try {
                    for (const [target,snapshot,refs] of snapshots) restoreState(target,snapshot,refs);
                    if (managerFields) for (const [field,value] of Object.entries(managerFields)) manager[field]=value;
                    if (counts && savedCounts) restoreState(counts,savedCounts);
                    if (textarea) { textarea.value=savedInput;textarea.readOnly=savedReadOnly; }
                } finally {
                    if (ctx.eventSource.emit===previewEmit)ctx.eventSource.emit=originalEmit;
                    guard?.restore(); previewing=false;
                }
            }
        },
    };
}

export async function installRequestPreview() {
    const { getContext } = await import('/scripts/extensions.js');
    const core = await import('/script.js');
    const regex = await import('/scripts/extensions/regex/engine.js');
    const wi = await import('/scripts/world-info.js');
    const openai = await import('/scripts/openai.js');
    const { hasPendingFileAttachment } = await import('/scripts/chats.js');
    return createRequestPreview({ getContext, isGenerating: core.isGenerating, hasAttachment: hasPendingFileAttachment,
        preprocess: text => regex.getRegexedString(text, regex.regex_placement.USER_INPUT), promptManager: ()=>openai.promptManager,
        async activeBooks(ctx) {
            const character=ctx.characters?.[ctx.characterId];
            const avatar=(character?.avatar??'').replace(/\.[^.]+$/,'');
            const extra=wi.world_info?.charLore?.find(x=>x.name===avatar)?.extraBooks??[];
            const names=new Set([...(wi.selected_world_info??[]),...extra,character?.data?.extensions?.world,ctx.chatMetadata?.world_info,ctx.powerUserSettings?.persona_description_lorebook].filter(Boolean));
            const books=[];for(const name of names){const book=await wi.loadWorldInfo(name);if(!book)throw new Error('启用的世界书读取失败，无法模拟。');books.push(book)}return books;
        },
    });
}
