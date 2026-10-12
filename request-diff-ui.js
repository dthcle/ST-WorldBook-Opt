import { compareInputs } from './prompt-diff.js';
import { applyGeometry, initialGeometry, makeMovable, readGeometry } from './window-drag.js';
import { defaultLayout, clampLayout } from './window-layout.js';

/** Compare only when a real previous request exists; otherwise there is nothing to diff. */
export function buildComparison(previous, current) {
    if (!current || !Array.isArray(current.messages)) throw new Error('捕获结果缺少消息列表');
    if (!previous || !Array.isArray(previous.messages)) return null;
    return compareInputs(previous.messages, current.messages);
}

export function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

export function button(text, clickAction) {
    const element = node('button', text, 'wbo-button');
    element.type = 'button';
    element.onclick = clickAction;
    return element;
}

export function markedText(text, range) {
    const pre = node('pre', undefined, 'wbo-request-text');
    if (text === null) { pre.textContent = '（字段不存在）'; return pre; }
    if (!range) { pre.textContent = text; return pre; }
    pre.append(document.createTextNode(text.slice(0, range.start)));
    pre.append(node('mark', range.end > range.start ? text.slice(range.start, range.end) : '空', 'wbo-diff-mark'));
    pre.append(document.createTextNode(text.slice(range.end)));
    return pre;
}

const MAX_RENDERED_LINES = 1500;

/**
 * Keep the overlay glued to the *visual* viewport invoked by the browser.
 * A plain `inset: 0` overlay is laid out against the layout viewport, so on
 * mobile it can sit above the visible area and only a thin strip shows.
 */
export function trackViewport(overlay, host) {
    const viewport = host.visualViewport;
    const apply = () => {
        const height = Math.round(viewport?.height ?? host.innerHeight ?? 0);
        const width = Math.round(viewport?.width ?? host.innerWidth ?? 0);
        const top = Math.round(viewport?.offsetTop ?? 0);
        if (height > 0) overlay.style.setProperty('--wbo-vh', height + 'px');
        if (width > 0) overlay.style.setProperty('--wbo-vw', width + 'px');
        overlay.style.setProperty('--wbo-top', top + 'px');
    };
    apply();
    viewport?.addEventListener('resize', apply);
    viewport?.addEventListener('scroll', apply);
    host.addEventListener('resize', apply);
    return () => {
        viewport?.removeEventListener('resize', apply);
        viewport?.removeEventListener('scroll', apply);
        host.removeEventListener('resize', apply);
    };
}

/** Unified line diff: one row per changed line, '-' before and '+' after. */
export function lineRows(lines, field, showEqual) {
    const all = lines.rows;
    const keep = new Set();
    if (showEqual) {
        all.forEach((row, index) => keep.add(index));
    } else {
        const context = 2;
        all.forEach((row, index) => {
            if (row.type === 'equal') return;
            for (let offset = Math.max(0, index - context); offset <= Math.min(all.length - 1, index + context); offset++) keep.add(offset);
        });
    }
    const visible = all.map((row, index) => ({ row, index })).filter(item => keep.has(item.index));
    const container = node('div', undefined, 'wbo-lines');
    container.append(node('p', '逐行差异：上次 ' + lines.beforeLineCount + ' 行 → 捕获 ' + lines.afterLineCount + ' 行；删除 ' + lines.deleteCount + ' 行、新增 ' + lines.insertCount + ' 行，相同行 ' + lines.matched + ' 行。替换按删除+新增统计，区段只是展示对齐，不是唯一标准答案。', 'wbo-muted'));
    if (lines.budgetExceeded) container.append(node('p', '文本对齐预算已耗尽，部分区段使用近似对齐；不要把展示行数当作最小编辑距离。', 'wbo-warning'));
    if (lines.hunks.length) {
        const ranges = lines.hunks.slice(0, 6).map(hunk => {
            const before = hunk.beforeStart === null ? '空' : hunk.beforeStart + '-' + hunk.beforeEnd;
            const after = hunk.afterStart === null ? '空' : hunk.afterStart + '-' + hunk.afterEnd;
            const parts = [];
            if (hunk.changes) parts.push('改 ' + hunk.changes);
            if (hunk.deletes) parts.push('删 ' + hunk.deletes);
            if (hunk.inserts) parts.push('增 ' + hunk.inserts);
            return '上次 ' + before + ' 行 → 捕获 ' + after + ' 行（' + parts.join('、') + '）';
        });
        container.append(node('p', '差异区段：' + ranges.join('；') + (lines.hunks.length > 6 ? '；…共 ' + lines.hunks.length + ' 段' : '') + '。', 'wbo-muted'));
    }
    let rendered = 0;
    const emit = (sign, number, text, range, className) => {
        const line = node('div', undefined, 'wbo-line ' + className);
        line.append(node('span', number === null ? '' : String(number + 1), 'wbo-line-no'), node('span', sign, 'wbo-line-sign'));
        line.append(range && text !== null ? markedText(text, range) : node('pre', text === null || text === undefined ? '（该侧没有这一行）' : text, 'wbo-line-text'));
        container.append(line);
    };
    const appendPage = () => {
        const end = Math.min(rendered + MAX_RENDERED_LINES, visible.length);
        for (; rendered < end; rendered++) {
            const row = visible[rendered].row;
            if (row.type === 'equal') {
                const line = node('div', undefined, 'wbo-line wbo-line-equal');
                line.append(node('span', String(row.beforeIndex + 1), 'wbo-line-no'), node('span', ' ', 'wbo-line-sign'), node('pre', row.beforeText, 'wbo-line-text'));
                container.append(line);
            } else if (row.type === 'change') {
                emit('−', row.beforeIndex, row.beforeText, row.beforeChanged, 'wbo-line-del');
                emit('+', row.afterIndex, row.afterText, row.afterChanged, 'wbo-line-add');
            } else if (row.type === 'delete') {
                emit('−', row.beforeIndex, row.beforeText, null, 'wbo-line-del');
            } else {
                emit('+', row.afterIndex, row.afterText, null, 'wbo-line-add');
            }
        }
        if (rendered < visible.length) {
            const more = button('加载后续行（尚余 ' + (visible.length - rendered) + ' 行）', () => { more.remove(); appendPage(); });
            container.append(more);
        }
    };
    appendPage();
    if (!visible.length) container.append(node('p', '没有逐行差异（仅字符级差异）。'));
    return container;
}

/** Fallback for fields too large to line-diff: side-by-side view. */
export function sideBySide(field) {
    const columns = node('div', undefined, 'wbo-diff');
    const sides = [['上次实际请求', field.beforeText, field.beforeChanged], ['当前捕获', field.afterText, field.afterChanged]];
    for (const side of sides) {
        const column = node('div');
        column.append(node('small', side[0]), markedText(side[1], side[2]));
        columns.append(column);
    }
    return columns;
}

export function mountRequestDiff(runtime, target = document.body, host = globalThis) {
    const overlay = node('div', undefined, 'wbo-overlay');
    const panel = node('section', undefined, 'wbo-panel wbo-request-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '请求输入差异');
    const opener = document.activeElement;
    let busy = false, result = null, diff = null, userMoved = false;
    const viewportDetach = trackViewport(overlay, host);
    const geometry = initialGeometry(host);
    applyGeometry(panel, geometry);
    const close = () => { if (busy) return; viewportDetach(); dragDetach(); overlay.remove(); if (opener && opener.focus) opener.focus(); };
    const header = node('header', undefined, 'wbo-drag');
    header.append(node('h2', '请求输入差异'), node('span', '拖动标题移动 · 右下角缩放', 'wbo-drag-hint'), button('关闭', close));
    const resizeHandle = node('div', undefined, 'wbo-resize');
    resizeHandle.setAttribute('role', 'button');
    resizeHandle.setAttribute('aria-label', '调整窗口大小');
    const dragDetach = makeMovable(panel, host, header, resizeHandle);

    const intro = node('p', '上次酒馆后端成功响应的实际请求，与当前输入组装后的最终 fetch 正文对比。预览请求在转发前截断，不只是依赖停止按钮。', 'wbo-muted');
    const warning = node('p', '仅支持标准浏览器 Chat Completion fetch 通道。组装会运行宏/插件，并可能将输入保存为用户消息，不是无副作用模拟；撤回不能回滚宏或插件状态。预览期间不要发送或切换聊天。', 'wbo-warning');
    const baseline = node('p', undefined, 'wbo-muted');
    const status = node('p', undefined, 'wbo-status');
    status.setAttribute('role', 'status');
    const toolbar = node('div', undefined, 'wbo-toolbar');
    const filter = node('select');
    filter.setAttribute('aria-label', '差异显示范围');
    const filterOptions = [['changed', '仅差异消息'], ['all', '全部消息（按发送顺序）']];
    for (const option of filterOptions) {
        const element = node('option', option[1]);
        element.value = option[0];
        filter.append(element);
    }
    const summary = node('div', undefined, 'wbo-summary');
    const showEqualLabel = node('label', undefined, 'wbo-lines-toggle');
    const showEqualLines = node('input');
    showEqualLines.type = 'checkbox';
    showEqualLabel.append(showEqualLines, document.createTextNode('显示未变化的行'));
    const undoBar = node('div', undefined, 'wbo-toolbar');
    undoBar.hidden = true;
    const cards = node('div', undefined, 'wbo-cards');

    function report(text, error = false) {
        status.textContent = text;
        status.classList.toggle('wbo-error', error);
    }

    function refreshBaseline() {
        const last = runtime.getLast();
        baseline.textContent = last
            ? '上次请求：' + new Date(last.sentAt).toLocaleString() + ' · ' + (last.model === null || last.model === undefined ? '未知模型' : last.model) + ' · ' + last.messages.length + ' 条消息。此功能只记录安装并刷新后真实发送过的请求。'
            : '当前聊天尚无请求记录。先正常发送一次消息建立基线；不会为建立基线自动调用模型。';
    }

    function renderCapture() {
        summary.replaceChildren();
        cards.replaceChildren();
        summary.append(node('strong', '本次捕获内容（还没有可对比的上一次请求）'));
        summary.append(node('p', '先正常发送一次消息建立基线，之后再捕获即可看到从头到尾的差异。'));
        for (const text of result.warnings) summary.append(node('p', text, 'wbo-muted'));
        result.current.messages.forEach((message, index) => {
            const card = node('article', undefined, 'wbo-card');
            card.dataset.messageIndex = String(index);
            card.append(node('strong', '#' + (index + 1) + ' · ' + (message.role === undefined ? '未知角色' : message.role)));
card.append(node('pre', typeof message.content === 'string' ? message.content : JSON.stringify(message.content === undefined ? message : message.content, null, 2)));
            cards.append(card);
        });
    }

    function renderComparison() {
        const first = diff.firstDifference;
        const firstRow = first ? diff.rows[first.index] : null;
        const firstField = firstRow ? firstRow.fieldDiffs.find(field => field.field === first.field) : null;
        const firstText = firstField ? (firstField.beforeText === null ? firstField.afterText : firstField.beforeText) : null;
        const firstLine = typeof firstText === 'string' ? firstText.slice(0, firstField.commonPrefix).split('\n').length : null;
        summary.replaceChildren();
        cards.replaceChildren();
        const headline = first
            ? '第一处差异：消息 #' + (first.index + 1) + ' · ' + first.field + (firstLine === null ? '' : ' · 第 ' + firstLine + ' 行') + ' · UTF-16 偏移 ' + first.characterPosition
            : '消息输入完全相同';
        summary.append(node('strong', headline));
        summary.append(node('p', '消息条数：上次 ' + result.previous.messages.length + ' → 捕获 ' + result.current.messages.length + '。规范化 JSON 相同前缀 ' + diff.prefixCharacters + ' 个 UTF-16 单元（上次总长 ' + diff.totalBefore + ' → 捕获 ' + diff.totalAfter + '）。这不是 token 数量，也不是 API 缓存命中率。'));
        if (result.previous.model !== result.current.model || result.previous.source !== result.current.source) {
            summary.append(node('p', '模型或提供商已变化：即使消息相同，也不应推断缓存可复用。', 'wbo-warning'));
        }
        for (const text of result.warnings) summary.append(node('p', text, 'wbo-muted'));
        const statusNames = { equal: '相同', changed: '变化', inserted: '新增', deleted: '删除' };
        for (const row of diff.rows) {
            if (filter.value === 'changed' && row.status === 'equal') continue;
            const card = node('article', undefined, 'wbo-card');
            card.dataset.messageIndex = String(row.index);
            card.append(node('strong', '#' + (row.index + 1) + ' · ' + (row.before === null ? '不存在' : row.before.role) + ' → ' + (row.after === null ? '不存在' : row.after.role) + ' · ' + statusNames[row.status]));
            if (first && first.index === row.index) card.append(node('p', '首个变化点：前缀在这里开始不同。', 'wbo-warning'));
            if (row.status === 'equal') {
                const details = node('details');
                details.append(node('summary', '查看相同消息'), node('pre', JSON.stringify(row.before, null, 2)));
                card.append(details);
            } else {
                for (const field of row.fieldDiffs) {
                    const lines = field.lineDiff;
                    const details = node('details');
                    details.open = true;
                    const fieldTitle = lines && lines.supported
                        ? field.field + ' · 删除 ' + lines.deleteCount + ' 行 / 新增 ' + lines.insertCount + ' 行 · ' + lines.hunks.length + ' 个展示区段'
                        : field.field + ' · 共同开头 ' + field.commonPrefix + ' · 共同结尾 ' + field.commonSuffix + '（UTF-16 单元）';
                    details.append(node('summary', fieldTitle));
                    details.append(lines && lines.supported ? lineRows(lines, field, showEqualLines.checked) : sideBySide(field));
                    if (lines && !lines.supported && lines.reason) details.append(node('p', lines.reason, 'wbo-muted'));
                    card.append(details);
                }
            }
            cards.append(card);
        }
        if (!cards.children.length) cards.append(node('p', '没有差异消息。'));
    }

    function render() {
        if (!result) return;
        if (diff) renderComparison(); else renderCapture();
    }

    const capture = button('捕获当前输入并对比', async () => {
        if (busy) return;
        busy = true;
        panel.setAttribute('aria-busy', 'true');
        panel.querySelectorAll('button,input,select').forEach(element => { element.disabled = true; });
        report('正在让酒馆组装提示词，随后会立刻取消请求……');
        try {
            const nextCapture = await runtime.captureCurrent();
            result = nextCapture;
            diff = buildComparison(nextCapture.previous, nextCapture.current);
            undoBar.hidden = !nextCapture.wroteMessage;
            refreshBaseline();
            render();
            report(nextCapture.previous
                ? '捕获完成，已取消本次 AI 请求。'
                : '捕获完成，已取消本次 AI 请求；此前没有真实请求记录，因此只列出本次捕获内容。');
        } catch (error) {
            undoBar.hidden = !(runtime.wroteChatMessage && runtime.wroteChatMessage());
            report(error.message, true);
        } finally {
            busy = false;
            panel.removeAttribute('aria-busy');
            panel.querySelectorAll('button,input,select').forEach(element => { element.disabled = false; });
        }
    });

    const undoButton = button('撤回该消息', async () => {
        try {
            await runtime.undoWrittenMessage();
            undoBar.hidden = true;
            report('已撤回本次捕获写入的消息。');
        } catch (error) {
            report(error.message, true);
        }
    });
    undoBar.append(node('span', '本次捕获写入了一条用户消息：', 'wbo-muted'), undoButton);

    const jumpButton = button('跳到第一处差异', () => {
        if (!diff || !diff.firstDifference) { report('还没有可跳转的差异。'); return; }
        if (showEqualLines.checked) { showEqualLines.checked = false; render(); }
        const card = cards.querySelector('[data-message-index="' + diff.firstDifference.index + '"]');
        if (card) card.scrollIntoView({ block: 'start' });
        const mark = card ? card.querySelector('mark') : null;
        if (mark) mark.scrollIntoView({ block: 'center' });
    });

    const clearButton = button('清除请求记录', () => {
        runtime.clear();
        result = null;
        diff = null;
        summary.replaceChildren();
        cards.replaceChildren();
        undoBar.hidden = !(runtime.wroteChatMessage && runtime.wroteChatMessage());
        refreshBaseline();
        report('内存中的请求记录已清除；安全撤回信息仍保留，不自动删除聊天消息。');
    });

    toolbar.append(capture, filter, showEqualLabel, jumpButton, clearButton);
    filter.onchange = render;
    showEqualLines.onchange = render;

    const body = node('div', undefined, 'wbo-panel-body');
    body.append(intro, warning, baseline, toolbar, undoBar, status, summary, cards);
    panel.append(header, body, resizeHandle);
    overlay.append(panel);
    target.append(overlay);
    refreshBaseline();
    const closeButton = header.querySelector('button');
    if (closeButton && closeButton.focus) closeButton.focus();
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
        if (event.key !== 'Tab') return;
        const focusable = Array.from(panel.querySelectorAll('button,input,select,summary'))
            .filter(element => !element.disabled && element.getClientRects().length);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    return { overlay, panel, detach: () => { viewportDetach(); dragDetach(); } };
}