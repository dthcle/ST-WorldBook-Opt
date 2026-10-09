import { compareInputs } from './prompt-diff.js';

/** Compare only when a real previous request exists; otherwise there is nothing to diff. */
export function buildComparison(previous, current) {
    if (!previous || !Array.isArray(previous.messages)) return null;
    if (!current || !Array.isArray(current.messages)) throw new Error('捕获结果缺少消息列表');
    return compareInputs(previous.messages, current.messages);
}

function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function button(text, click) { const n = node('button', text, 'wbo-button'); n.type = 'button'; n.onclick = click; return n; }
function markedText(text, range) {
    const pre = node('pre', undefined, 'wbo-request-text');
    if (text === null) { pre.textContent = '（字段不存在）'; return pre; }
    if (!range) { pre.textContent = text; return pre; }
    pre.append(document.createTextNode(text.slice(0, range.start)));
    pre.append(node('mark', range.end > range.start ? text.slice(range.start, range.end) : '∅', 'wbo-diff-mark'));
    pre.append(document.createTextNode(text.slice(range.end)));
    return pre;
}

const MAX_RENDERED_LINES = 1500;

/** Unified, line-oriented diff: each changed line shows as one '-' and one '+' row. */
function lineRows(lines, field, showEqual = false) {
    const all = lines.rows;
    const keep = new Set();
    if (showEqual) {
        all.forEach((_, index) => keep.add(index));
    } else {
        const context = 2;
        all.forEach((row, index) => {
            if (row.type === 'equal') return;
            for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep.add(k);
        });
    }
    const visible = all.map((row, index) => ({ row, index })).filter(item => keep.has(item.index));
    const container = node('div', undefined, 'wbo-lines');
    container.append(node('p', `逐行差异：上次 ${lines.beforeLineCount} 行 → 捕获 ${lines.afterLineCount} 行，其中变化 ${lines.changedLineCount} 行，集中在 ${lines.hunks.length} 个区段。字符偏移不是 token 数。`, 'wbo-muted'));
    if (lines.hunks.length) {
        const ranges = lines.hunks.slice(0, 6).map(hunk => {
            const before = hunk.beforeStart === null ? '—' : `${hunk.beforeStart}–${hunk.beforeEnd}`;
            const after = hunk.afterStart === null ? '—' : `${hunk.afterStart}–${hunk.afterEnd}`;
            const detail = [hunk.changes ? `改 ${hunk.changes}` : '', hunk.deletes ? `删 ${hunk.deletes}` : '', hunk.inserts ? `增 ${hunk.inserts}` : ''].filter(Boolean).join('、');
            return `上次 ${before} 行 → 捕获 ${after} 行（${detail}）`;
        });
        container.append(node('p', `差异区段：${ranges.join('；')}${lines.hunks.length > 6 ? `；…共 ${lines.hunks.length} 段` : ''}。`, 'wbo-muted'));
    }
    const useTwoColumns = all.some(row => (row.beforeText ?? row.afterText ?? '').length > 400);
    container.classList.toggle('wbo-lines-wide', useTwoColumns);
    let rendered = 0;
    for (const { row } of visible) {
        if (rendered++ >= MAX_RENDERED_LINES) {
            container.append(node('p', '差异行过多，已截断显示；请用“仅差异消息”过滤或直接查看完整正文。', 'wbo-warning'));
            break;
        }
        if (row.type === 'equal') {
            const line = node('div', undefined, 'wbo-line wbo-line-equal');
            line.append(node('span', String(row.beforeIndex + 1), 'wbo-line-no'), node('span', ' ', 'wbo-line-sign'), node('pre', row.beforeText, 'wbo-line-text'));
            container.append(line);
            continue;
        }
        const emit = (sign, number, text, range, className) => {
            const line = node('div', undefined, `wbo-line ${className}`);
            line.append(node('span', number === null ? '' : String(number + 1), 'wbo-line-no'), node('span', sign, 'wbo-line-sign'));
            line.append(range && text !== null ? markedText(text, range) : node('pre', text ?? '（该侧没有这一行）', 'wbo-line-text'));
            container.append(line);
        };
        if (row.type === 'change') {
            emit('−', row.beforeIndex, row.beforeText, row.beforeChanged, 'wbo-line-del');
            emit('+', row.afterIndex, row.afterText, row.afterChanged, 'wbo-line-add');
        } else if (row.type === 'delete') {
            emit('−', row.beforeIndex, row.beforeText, null, 'wbo-line-del');
        } else {
            emit('+', row.afterIndex, row.afterText, null, 'wbo-line-add');
        }
    }
    if (!visible.length) container.append(node('p', '没有逐行差异（仅字符级差异）。'));
    return container;
}

/** Fallback for fields too large to line-diff: the original side-by-side view. */
function sideBySide(field) {
    const columns = node('div', undefined, 'wbo-diff');
    for (const [title, text, range] of [['上次实际请求', field.beforeText, field.beforeChanged], ['当前捕获', field.afterText, field.afterChanged]]) {
        const col = node('div'); col.append(node('small', title), markedText(text, range)); columns.append(col);
    }
    return columns;
}

export function mountRequestDiff(runtime, target = document.body) {
    const overlay = node('div', undefined, 'wbo-overlay');
    const panel = node('section', undefined, 'wbo-panel wbo-request-panel');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '请求输入差异');
    const opener = document.activeElement;
    let busy = false, result = null, diff = null;
    const close = () => { if (!busy) { overlay.remove(); opener?.focus(); } };

    const header = node('header');
    header.append(node('h2', '请求输入差异'), button('关闭', close));
    const intro = node('p', '把输入框内容真正走一遍酒馆的组装流程，在发请求前拦下提示词，再与上一次真实请求对比。不会发出 API 请求，也不会产生费用。', 'wbo-muted');
    const warning = node('p', '与酒馆“提示词查看器”原理相同：输入框内容会被写入聊天作为一条用户消息（相当于点了发送），随后取消 AI 请求。捕获后可在下方撤回该消息。', 'wbo-warning');
    const baseline = node('p', undefined, 'wbo-muted');
    const status = node('p', undefined, 'wbo-status'); status.setAttribute('role', 'status');
    const toolbar = node('div', undefined, 'wbo-toolbar');
    const filter = node('select'); filter.setAttribute('aria-label', '差异显示范围');
    for (const [v, t] of [['changed', '仅差异消息'], ['all', '全部消息（按发送顺序）']]) { const o = node('option', t); o.value = v; filter.append(o); }
    const summary = node('div', undefined, 'wbo-summary');
    const showEqualLabel = node('label', undefined, 'wbo-lines-toggle');
    const showEqualLines = node('input'); showEqualLines.type = 'checkbox';
    showEqualLabel.append(showEqualLines, document.createTextNode('显示未变化的行'));
    const undoBar = node('div', undefined, 'wbo-toolbar'); undoBar.hidden = true;
    const cards = node('div', undefined, 'wbo-cards');

    function report(text, error = false) { status.textContent = text; status.classList.toggle('wbo-error', error); }
    function refreshBaseline() {
        const last = runtime.getLast();
        baseline.textContent = last
            ? `上次请求：${new Date(last.sentAt).toLocaleString()} · ${last.model ?? '未知模型'} · ${last.messages.length} 条消息。此功能只记录安装并刷新后真实发送过的请求。`
            : '当前聊天尚无请求记录。先正常发送一次消息建立基线；不会为建立基线自动调用模型。';
    }
    function render() {
        if (!result) return;
        summary.replaceChildren(); cards.replaceChildren();
        if (!diff) {
            // No real request captured yet: list what was captured instead of comparing.
            summary.append(node('strong', '本次捕获内容（还没有可对比的上一次请求）'));
            summary.append(node('p', '先正常发送一次消息建立基线，之后再捕获即可看到从头到尾的差异。'));
            for (const text of result.warnings) summary.append(node('p', text, 'wbo-muted'));
            result.current.messages.forEach((message, index) => {
                const card = node('article', undefined, 'wbo-card');
                card.dataset.messageIndex = String(index);
                card.append(node('strong', `#${index + 1} · ${message.role ?? '未知角色'}`));
                card.append(node('pre', typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? message, null, 2)));
                cards.append(card);
            });
            return;
        }
        const first = diff.firstDifference;
        summary.append(node('strong', first ? `第一处差异：消息 #${first.index + 1} · ${first.field} · 字段偏移 ${first.characterPosition}` : '消息输入完全相同'));
        summary.append(node('p', `规范化消息 JSON 的相同前缀：${diff.prefixCharacters} 个 UTF-16 单元。上次 ${diff.totalBefore} → 捕获 ${diff.totalAfter}。这不是 token 数量，也不是 API 缓存命中率。`));
        if (result.previous && (result.previous.model !== result.current.model || result.previous.source !== result.current.source)) {
            summary.append(node('p', '模型或提供商已变化：即使消息相同，也不应推断缓存可复用。', 'wbo-warning'));
        }
        for (const text of result.warnings) summary.append(node('p', text, 'wbo-muted'));
        for (const row of diff.rows) {
            if (filter.value === 'changed' && row.status === 'equal') continue;
            const card = node('article', undefined, 'wbo-card');
            card.dataset.messageIndex = String(row.index);
            card.append(node('strong', `#${row.index + 1} · ${row.before?.role ?? '不存在'} → ${row.after?.role ?? '不存在'} · ${{ equal: '相同', changed: '变化', inserted: '新增', deleted: '删除' }[row.status]}`));
            if (first?.index === row.index) card.append(node('p', '首个变化点：前缀在这里开始不同。', 'wbo-warning'));
            if (row.status === 'equal') {
                const details = node('details');
                details.append(node('summary', '查看相同消息'), node('pre', JSON.stringify(row.before, null, 2)));
                card.append(details);
            } else {
                for (const field of row.fieldDiffs) {
                    const lines = field.lineDiff;
                    const details = node('details'); details.open = true;
                    const summaryText = lines?.supported
                        ? `${field.field} · 共 ${lines.beforeLineCount} 行，变化 ${lines.changedLineCount} 行，${lines.hunks.length} 个区段`
                        : `${field.field} · 共同开头 ${field.commonPrefix} · 共同结尾 ${field.commonSuffix}（UTF-16 单元）`;
                    details.append(node('summary', summaryText));
                    details.append(lines?.supported
                        ? lineRows(lines, field, showEqualLines.checked)
                        : sideBySide(field));
                    if (!lines?.supported && lines?.reason) details.append(node('p', lines.reason, 'wbo-muted'));
                    card.append(details);
                }
            }
            cards.append(card);
        }
        if (!cards.children.length) cards.append(node('p', '没有差异消息。'));
    }

    const capture = button('捕获当前输入并对比', async () => {
        if (busy) return;
        busy = true; panel.setAttribute('aria-busy', 'true'); panel.querySelectorAll('button,input,select').forEach(n => { n.disabled = true; });
        report('正在让酒馆组装提示词，随后会立刻取消请求……');
        try {
            const next = await runtime.captureCurrent();
            result = next;
            diff = buildComparison(next.previous, next.current);
            undoBar.hidden = !next.wroteMessage;
            refreshBaseline(); render();
            report(next.previous ? '捕获完成，已取消本次 AI 请求。' : '捕获完成，已取消本次 AI 请求；此前没有真实请求记录，因此只列出本次捕获内容。');
        } catch (error) {
            result = null; diff = null; summary.replaceChildren(); cards.replaceChildren();
            report(error.message, true);
        } finally {
            busy = false; panel.removeAttribute('aria-busy'); panel.querySelectorAll('button,input,select').forEach(n => { n.disabled = false; });
        }
    });

    undoBar.append(node('span', '本次捕获写入了一条用户消息：', 'wbo-muted'), button('撤回该消息', async () => {
        try { await runtime.undoWrittenMessage(); undoBar.hidden = true; report('已撤回本次捕获写入的消息。'); }
        catch (error) { report(error.message, true); }
    }));

    toolbar.append(
        capture,
        filter,
        showEqualLabel,
        button('跳到第一处差异', () => {
            if (!diff?.firstDifference) { report('还没有可跳转的差异。'); return; }
            const card = cards.querySelector(`[data-message-index="${diff.firstDifference.index}"]`);
            card?.scrollIntoView({ block: 'start' });
            card?.querySelector('mark')?.scrollIntoView({ block: 'center' });
        }),
        button('清除请求记录', () => { runtime.clear(); result = null; diff = null; summary.replaceChildren(); cards.replaceChildren(); undoBar.hidden = true; refreshBaseline(); report('内存中的请求记录已清除（不会删除已写入聊天的消息）。'); }),
    );
    filter.onchange = render;
    showEqualLines.onchange = render;
    panel.append(header, intro, warning, baseline, toolbar, undoBar, status, summary, cards);
    overlay.append(panel); target.append(overlay);
    refreshBaseline(); header.querySelector('button').focus();
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Tab') {
            const nodes = [...panel.querySelectorAll('button,input,select,summary')].filter(x => !x.disabled && x.getClientRects().length);
            if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
            else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
        }
    });
    return overlay;
}
