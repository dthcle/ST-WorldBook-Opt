/** Independent original implementation; no SillyTavern implementation code is copied.
 * Enum interoperability verified against upstream release:
 * https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js
 * Roles are imported there from ../script.js:
 * https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js
 * This planner does not execute templates, simulate ST activation, or call an API.
 */
export const POSITION = Object.freeze({ before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 });
export const ROLE = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
export const ENGINE_WARNINGS = Object.freeze([
    '动态内容检测为启发式、非完备；扩展、自定义宏及实际运行环境可能改变结果。',
    '改变角色、深度、冷却或常驻状态可能改变提示优先级、触发语义与 token 用量；应用前逐条复核并备份。',
    'D9999 只是请求的深度值，不保证置于全部提示之前，也不保证服务商缓存；实际插入受聊天长度、上下文裁剪和 ST 版本影响。',
    'estimated tokens 是内容字符启发式估算，不是 tokenizer 实测、API 缓存命中率或费用节省预测。',
    '未识别字段原样保留；本工具不能证明未知扩展字段没有特殊行为。',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
function jsonIssues(value, path, ancestors, issues) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') { issues.push(`${path}: 必须是有限的 JSON 值`); return; }
    if (ancestors.has(value)) { issues.push(`${path}: 不允许循环引用`); return; }
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        issues.push(`${path}: 必须是普通 JSON 对象`); return;
    }
    if (Object.getOwnPropertySymbols(value).length) issues.push(`${path}: 不允许 Symbol 属性`);
    ancestors.add(value);
    for (const k of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, k);
        if (!Object.hasOwn(descriptor, 'value')) { issues.push(`${path}.${k}: 不允许访问器属性`); continue; }
        jsonIssues(descriptor.value, `${path}.${k}`, ancestors, issues);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) issues.push(`${path}: 不允许稀疏数组或额外数组属性`);
    ancestors.delete(value);
}
/** Validate native {entries: {[id]: entry}}; never coerce or repair the input. */
export function validateWorldInfo(book) {
    const errors = [];
    jsonIssues(book, '$', new Set(), errors);
    if (errors.length) return { valid: false, errors };
    if (!record(book) || !Object.hasOwn(book, 'entries') || !record(book.entries)) {
        return { valid: false, errors: ['必须是 SillyTavern native JSON，entries 必须是对象（不支持数组或其他导出格式）'] };
    }
    const seen = new Set();
    for (const [id, e] of Object.entries(book.entries)) {
        const p = `entries[${JSON.stringify(id)}]`;
        if (!record(e)) { errors.push(`${p}: 条目必须是对象`); continue; }
        if (!Number.isSafeInteger(e.uid) || e.uid < 0) errors.push(`${p}.uid: 必须是非负安全整数`);
        else if (seen.has(e.uid)) errors.push(`${p}.uid: uid 重复`);
        seen.add(e.uid);
        for (const field of ['disable', 'constant', 'selective']) if (typeof e[field] !== 'boolean') errors.push(`${p}.${field}: 必须是布尔值`);
        if (!Number.isSafeInteger(e.position) || e.position < 0) errors.push(`${p}.position: 必须是非负安全整数`);
        if (!Number.isSafeInteger(e.order)) errors.push(`${p}.order: 必须是安全整数`);
        if (typeof e.content !== 'string') errors.push(`${p}.content: 必须是字符串`);
        if (!Array.isArray(e.key) || e.key.some(k => typeof k !== 'string')) errors.push(`${p}.key: 必须是字符串数组`);
        if (e.keysecondary !== undefined && (!Array.isArray(e.keysecondary) || e.keysecondary.some(k => typeof k !== 'string'))) errors.push(`${p}.keysecondary: 必须是字符串数组`);
        for (const field of ['depth', 'cooldown']) {
            if (e[field] !== undefined && e[field] !== null && (!Number.isSafeInteger(e[field]) || e[field] < 0)) errors.push(`${p}.${field}: 必须是非负安全整数或 null`);
        }
        if (e.position === POSITION.atDepth && !Number.isSafeInteger(e.depth)) errors.push(`${p}.depth: 深度条目必须有整数 depth`);
        if (e.role !== undefined && e.role !== null && !Object.values(ROLE).includes(e.role)) errors.push(`${p}.role: 未知角色枚举`);
        if (e.position === POSITION.atDepth && !Object.values(ROLE).includes(e.role)) errors.push(`${p}.role: 深度条目必须有有效角色`);
    }
    return { valid: errors.length === 0, errors };
}
function requireBook(book) {
    const result = validateWorldInfo(book);
    if (!result.valid) {
        const error = new TypeError(result.errors.join('\n'));
        error.errors = result.errors;
        throw error;
    }
}
/** Detection only, never eval. All macros are conservative dynamic candidates,
 * including unrecognised and incomplete template syntax. False positives/negatives possible. */
export function detectDynamicContent(content) {
    if (typeof content !== 'string') throw new TypeError('content 必须是字符串');
    const reasons = [];
    if (/<%|%>/.test(content)) reasons.push('EJS 模板标记');
    if (/\bMVU\b|\bstat_data\b|\b(?:getvar|getglobalvar|setvar|setglobalvar|addvar|incvar|decvar)\b|UpdateVariable|变量更新|变量操作/i.test(content)) reasons.push('MVU / 变量引用或更新标记');
    if (/\{\{|\}\}|\$\{/.test(content)) reasons.push('宏 / 插值（含未知或不完整宏）');
    if (/\b(?:Math\s*\.\s*random|random\s*\(|Date\s*\.\s*now|new\s+Date\s*\(|strftime\s*\()/i.test(content)) reasons.push('随机 / 时间表达式');
    return { dynamic: reasons.length > 0, reasons, heuristic: true };
}
/** Content-only estimate: ASCII code points / 4 + other code points / 1.5,
 * rounded up per entry. Not an activation or cache estimate. */
export function estimateTokens(content) {
    if (typeof content !== 'string') throw new TypeError('content 必须是字符串');
    let weight = 0;
    for (const char of content) weight += char.codePointAt(0) <= 127 ? 0.25 : 2 / 3;
    return Math.ceil(weight);
}
function specialReasons(e, id) {
    const reasons = [];
    if (id !== String(e.uid)) reasons.push('对象键与 uid 不一致，避免身份歧义');
    if (e.disable) reasons.push('禁用条目保持原样');
    if (!Object.values(POSITION).includes(e.position)) reasons.push('未知 position 枚举');
    if ([POSITION.ANTop, POSITION.ANBottom, POSITION.EMTop, POSITION.EMBottom, POSITION.outlet].includes(e.position)) reasons.push('作者注释 / 示例 / outlet 专用位置');
    const active = v => v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && (!Array.isArray(v) || v.length > 0);
    for (const field of ['vectorized', 'sticky', 'delay', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'group', 'groupOverride', 'automationId', 'outletName', 'triggers', 'decorators']) {
        if (active(e[field])) reasons.push(`特殊行为 ${field}`);
    }
    if (/^\s*@@(?:activate|dont_activate)\b/m.test(e.content)) reasons.push('内容激活装饰器');
    if (e.ignoreBudget) reasons.push('绕过 token 预算');
    if (e.selective && e.keysecondary?.length) reasons.push('次级关键词选择逻辑');
    if (e.useProbability && e.probability !== 100) reasons.push('概率触发');
    if (record(e.characterFilter) && (e.characterFilter.names?.length || e.characterFilter.tags?.length)) reasons.push('角色 / 标签筛选');
    if (record(e.extensions) && Object.keys(e.extensions).length) reasons.push('未知扩展行为');
    return reasons;
}
/** Shallow static green becomes constant only when strictly before a handled
 * dynamic entry in resulting user D0 block (order DESC). Ties are ambiguous.
 * Only constant/cooldown/position/depth/role may be changed. */
export function analyzeWorldInfo(book) {
    requireBook(book);
    const entries = Object.entries(book.entries).map(([id, e]) => {
        const detection = detectDynamicContent(e.content);
        const skip = specialReasons(e, id);
        return { id, uid: e.uid, before: clone(e), after: clone(e), changed: false, changedFields: [], risks: [], reasons: [], dynamic: detection.dynamic, detection, skipped: skip.length > 0, estimatedTokens: estimateTokens(e.content), skip };
    });
    const hasOriginalData = Object.hasOwn(book, 'originalData');
    const dynamicEntries = entries.filter(e => e.dynamic && !e.skipped);
    for (const item of entries) {
        const e = item.before, a = item.after;
        if (item.skipped) {
            item.reasons.push(...item.skip);
            item.risks.push('保守跳过整条，不清零冷却、不改变任何字段。');
        } else {
            a.cooldown = 0;
            if (e.cooldown !== 0) item.reasons.push('冷却清零');
            if (item.dynamic) {
                a.position = POSITION.atDepth; a.depth = 0; a.role = ROLE.USER;
                item.reasons.push('动态候选移至 user D0，保留原 constant 状态', ...item.detection.reasons);
                item.risks.push('检测非完备；改变注入位置/角色可能影响模板作用域与指令优先级。');
            } else if (e.position === POSITION.atDepth) {
                a.role = ROLE.USER;
                if (e.depth >= 10) {
                    a.depth = 9999; a.constant = true;
                    item.reasons.push('静态深度 ≥10：常驻 user D9999');
                    item.risks.push('D9999 不保证绝对前置；上下文裁剪或版本差异会影响插入。');
                } else {
                    a.depth = 0;
                    item.reasons.push('静态深度 0–9：移至 user D0');
                    if (!e.constant && dynamicEntries.some(d => e.order > d.before.order)) {
                        a.constant = true;
                        item.reasons.push('order DESC 严格位于动态候选之前的绿灯：转常驻');
                        item.risks.push('此前后关系基于完整方案；仅应用部分选项（未应用关联动态条目）时可能不成立。');
                    }
                    if (!e.constant && dynamicEntries.some(d => e.order === d.before.order)) item.risks.push('与动态条目 order 相同：无法确定前后顺序，不因该并列项转常驻。');
                }
            } else if (!e.constant) {
                a.constant = true;
                item.reasons.push('非深度静态绿灯：仅转常驻，位置/角色/深度保持');
            } else item.reasons.push('非深度静态蓝灯：位置/角色/深度/常驻保持（仍清零冷却）');
            if (!e.constant && a.constant) item.risks.push('绿灯转常驻将绕过关键词激活条件，可能增加每轮 token 用量或泄露未触发设定。');
            if (e.cooldown > 0) item.risks.push('清零冷却会取消原有重复激活间隔。');
            if (a.role !== e.role || a.depth !== e.depth || a.position !== e.position) item.risks.push('角色 / 深度 / 位置变化会改变提示结构；不保证行为等价。');
            item.changedFields = ['constant', 'cooldown', 'position', 'depth', 'role'].filter(k => !equal(e[k], a[k]));
            item.changed = item.changedFields.length > 0;
        }
        if (hasOriginalData) item.risks.push('整本含 originalData：仅可预览，本引擎拒绝应用；嵌套原始格式字段映射未经可靠确认，后续 ST 导出可能恢复旧字段。');
        delete item.skip;
    }
    const sum = list => list.reduce((n, e) => n + e.estimatedTokens, 0);
    const enabled = entries.filter(e => !e.before.disable);
    return {
        version: 1, entries, warnings: [...ENGINE_WARNINGS, ...(hasOriginalData ? ['检测到 originalData：只提供预览，整本拒绝应用；请先取得无 originalData 的原生世界书，勿手动删除嵌套源数据冒充无损导出。'] : [])],
        stats: {
            total: entries.length, enabled: enabled.length, disabled: entries.length - enabled.length,
            dynamic: entries.filter(e => e.dynamic).length, static: entries.filter(e => !e.dynamic).length,
            changed: entries.filter(e => e.changed).length, skipped: entries.filter(e => e.skipped).length,
            estimatedTokens: sum(entries), estimatedEnabledTokens: sum(enabled),
            estimatedConstantTokensBefore: sum(enabled.filter(e => e.before.constant)),
            estimatedConstantTokensAfter: sum(enabled.filter(e => e.after.constant)),
            tokenEstimateMethod: '按条目 ceil(ASCII码点/4 + 其他码点/1.5)，仅内容；不模拟激活，不含包装或模板展开',
        },
    };
}
/** Apply explicitly selected object-key IDs. Reject stale or altered selected
 * proposals; always recompute trusted changes. All nonselected data is cloned.
 * No default-all action, no uid remapping, no writes or side effects. */
export function applyPlan(book, plan, selectedIds) {
    requireBook(book);
    if (Object.hasOwn(book, 'originalData')) throw new TypeError('拒绝应用：整本含 originalData，无法可靠同步嵌套源格式字段；继续导出可能恢复旧设置。请使用无 originalData 的原生世界书。');
    if (!record(plan) || plan.version !== 1 || !Array.isArray(plan.entries)) throw new TypeError('无效方案');
    if (!Array.isArray(selectedIds) || selectedIds.some(id => typeof id !== 'string')) throw new TypeError('selectedIds 必须是对象键字符串数组');
    if (new Set(selectedIds).size !== selectedIds.length) throw new TypeError('selectedIds 含重复对象键');
    const fresh = analyzeWorldInfo(book);
    const result = clone(book);
    for (const id of selectedIds) {
        const canonical = fresh.entries.find(e => e.id === id);
        const candidates = plan.entries.filter(e => e?.id === id);
        if (!canonical || candidates.length !== 1) throw new TypeError(`选中条目不存在或方案重复：${id}`);
        if (!equal(candidates[0].before, canonical.before)) throw new TypeError(`条目已变化，请重新分析：${id}`);
        if (!equal(candidates[0].after, canonical.after)) throw new TypeError(`方案已被修改，请重新分析：${id}`);
        if (canonical.changed && !canonical.skipped) result.entries[id] = clone(canonical.after);
    }
    return result;
}
