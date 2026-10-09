/** Line-oriented refinement for prompt fields. Pure, dependency-free, no token metric.
 * The goal is a directly readable diff: which lines changed, and what changed inside them.
 * Alignment is a bounded lookahead heuristic (not a full LCS), so it stays linear-ish even
 * for the very large prompt blocks this extension deals with. All offsets are UTF-16 units.
 */
const MAX_CHARS = 1_500_000;
const MAX_LINES = 40_000;
const LOOKAHEAD = 8;

export function splitLines(text) {
    if (typeof text !== 'string') throw new TypeError('text 必须是字符串');
    return text === '' ? [] : text.split('\n');
}

function commonEnds(a, b) {
    const limit = Math.min(a.length, b.length);
    let start = 0;
    while (start < limit && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    let suffix = 0;
    const rest = limit - start;
    while (suffix < rest && a.charCodeAt(a.length - suffix - 1) === b.charCodeAt(b.length - suffix - 1)) suffix++;
    return { start, suffix };
}

/** Align two line arrays. Equal lines pair up; small shifts become insert/delete rows. */
export function alignLines(beforeLines, afterLines) {
    const rows = [];
    let i = 0, j = 0;
    while (i < beforeLines.length && j < afterLines.length) {
        if (beforeLines[i] === afterLines[j]) {
            rows.push({ type: 'equal', beforeIndex: i, afterIndex: j });
            i++; j++;
            continue;
        }
        let shift = 0;
        for (let k = 1; k <= LOOKAHEAD; k++) {
            if (j + k < afterLines.length && beforeLines[i] === afterLines[j + k]) { shift = k; break; }
            if (i + k < beforeLines.length && beforeLines[i + k] === afterLines[j]) { shift = -k; break; }
        }
        if (shift > 0) {
            for (let k = 0; k < shift; k++) rows.push({ type: 'insert', beforeIndex: null, afterIndex: j + k });
            j += shift;
        } else if (shift < 0) {
            for (let k = 0; k < -shift; k++) rows.push({ type: 'delete', beforeIndex: i + k, afterIndex: null });
            i += -shift;
        } else {
            rows.push({ type: 'change', beforeIndex: i, afterIndex: j });
            i++; j++;
        }
    }
    while (i < beforeLines.length) rows.push({ type: 'delete', beforeIndex: i++, afterIndex: null });
    while (j < afterLines.length) rows.push({ type: 'insert', beforeIndex: null, afterIndex: j++ });
    return rows;
}

/**
 * @returns {{supported:boolean,reason?:string,beforeLineCount:number,afterLineCount:number,
 *   changedLineCount:number,rows:Array<{type,beforeIndex,afterIndex,beforeText,afterText,
 *   beforeChanged:{start,end}|null,afterChanged:{start,end}|null}>}}
 * Unchanged lines are included as 'equal' rows so callers can show context; the UI filters them.
 */
export function diffLines(before, after, { maxChars = MAX_CHARS, maxLines = MAX_LINES } = {}) {
    const a = before ?? '', b = after ?? '';
    const common = commonEnds(a, b);
    const beforeLines = splitLines(a), afterLines = splitLines(b);
    const unsupported = reason => ({
        supported: false, reason, beforeLineCount: beforeLines.length, afterLineCount: afterLines.length,
        changedLineCount: 0, rows: [], commonPrefix: common.start, commonSuffix: common.suffix,
    });
    if (a.length + b.length > maxChars) return unsupported('文本过大，未逐行对比。');
    if (beforeLines.length + afterLines.length > maxLines) return unsupported('行数过多，未逐行对比。');

    const aligned = alignLines(beforeLines, afterLines);
    let changedLineCount = 0;
    const rows = aligned.map(row => {
        const beforeText = row.beforeIndex === null ? null : beforeLines[row.beforeIndex];
        const afterText = row.afterIndex === null ? null : afterLines[row.afterIndex];
        if (row.type !== 'equal') changedLineCount++;
        if (row.type !== 'change') {
            return { type: row.type, beforeIndex: row.beforeIndex, afterIndex: row.afterIndex, beforeText, afterText, beforeChanged: null, afterChanged: null };
        }
        const inner = commonEnds(beforeText, afterText);
        return {
            type: 'change', beforeIndex: row.beforeIndex, afterIndex: row.afterIndex, beforeText, afterText,
            beforeChanged: { start: inner.start, end: beforeText.length - inner.suffix },
            afterChanged: { start: inner.start, end: afterText.length - inner.suffix },
        };
    });
    return {
        supported: true, beforeLineCount: beforeLines.length, afterLineCount: afterLines.length,
        changedLineCount, rows, commonPrefix: common.start, commonSuffix: common.suffix,
    };
}
