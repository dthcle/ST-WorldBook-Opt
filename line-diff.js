/** Line-oriented refinement for prompt fields. Pure, dependency-free, no token metric.
 * The goal is a directly readable diff: which lines changed, and what changed inside them.
 * Alignment is a bounded lookahead heuristic (not a full LCS), so it stays linear-ish even
 * for the very large prompt blocks this extension deals with. All offsets are UTF-16 units.
 */
const MAX_CHARS = 1_500_000;
const MAX_LINES = 40_000;
const MAX_DEPTH = 64;
const SMALL_REGION = 8;

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

function countLines(lines) {
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
}

/** Longest strictly increasing subsequence of indices, by `value`. */
function longestIncreasing(items, value) {
    const tails = [], previous = new Array(items.length).fill(-1), tailIndex = [];
    for (let index = 0; index < items.length; index++) {
        const target = value(items[index]);
        let low = 0, high = tails.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (tails[mid] < target) low = mid + 1; else high = mid;
        }
        tails[low] = target;
        previous[index] = low > 0 ? tailIndex[low - 1] : -1;
        tailIndex[low] = index;
    }
    const result = [];
    for (let index = tailIndex[tails.length - 1]; index !== undefined && index >= 0; index = previous[index]) result.push(items[index]);
    return result.reverse();
}

/**
 * Patience-style alignment: anchor on lines that are unique in both sides, keep the longest
 * consistent chain (LIS), then recurse between anchors. This stays correct when a whole block
 * is rewritten or shifted, unlike a greedy lookahead scan.
 */
export function alignLines(beforeLines, afterLines) {
    const beforeCount = countLines(beforeLines), afterCount = countLines(afterLines);
    const out = [];
    const pairUp = (aStart, aEnd, bStart, bEnd) => {
        const aLength = aEnd - aStart, bLength = bEnd - bStart;
        // Only pair neighbouring lines when both sides are small: pairing an 11-line block with
        // a 700-line block would invent 1:1 "changes" that never existed.
        if (aLength <= SMALL_REGION && bLength <= SMALL_REGION) {
            const shared = Math.min(aLength, bLength);
            for (let k = 0; k < shared; k++) out.push({ type: 'change', beforeIndex: aStart + k, afterIndex: bStart + k });
            for (let i = aStart + shared; i < aEnd; i++) out.push({ type: 'delete', beforeIndex: i, afterIndex: null });
            for (let j = bStart + shared; j < bEnd; j++) out.push({ type: 'insert', beforeIndex: null, afterIndex: j });
            return;
        }
        for (let i = aStart; i < aEnd; i++) out.push({ type: 'delete', beforeIndex: i, afterIndex: null });
        for (let j = bStart; j < bEnd; j++) out.push({ type: 'insert', beforeIndex: null, afterIndex: j });
    };
    const recurse = (aStart, aEnd, bStart, bEnd, depth) => {
        while (aStart < aEnd && bStart < bEnd && beforeLines[aStart] === afterLines[bStart]) {
            out.push({ type: 'equal', beforeIndex: aStart, afterIndex: bStart });
            aStart++; bStart++;
        }
        const suffix = [];
        while (aEnd > aStart && bEnd > bStart && beforeLines[aEnd - 1] === afterLines[bEnd - 1]) {
            aEnd--; bEnd--;
            suffix.push({ type: 'equal', beforeIndex: aEnd, afterIndex: bEnd });
        }
        if (aStart === aEnd) {
            for (let j = bStart; j < bEnd; j++) out.push({ type: 'insert', beforeIndex: null, afterIndex: j });
        } else if (bStart === bEnd) {
            for (let i = aStart; i < aEnd; i++) out.push({ type: 'delete', beforeIndex: i, afterIndex: null });
        } else if (depth >= MAX_DEPTH) {
            pairUp(aStart, aEnd, bStart, bEnd);
        } else {
            const positions = new Map();
            for (let i = aStart; i < aEnd; i++) {
                const line = beforeLines[i];
                if (beforeCount.get(line) === 1 && afterCount.get(line) === 1) positions.set(line, i);
            }
            const anchors = [];
            if (positions.size) {
                for (let j = bStart; j < bEnd; j++) {
                    const line = afterLines[j];
                    if (afterCount.get(line) === 1 && positions.has(line)) anchors.push([positions.get(line), j]);
                }
            }
            if (!anchors.length) {
                pairUp(aStart, aEnd, bStart, bEnd);
            } else {
                anchors.sort((left, right) => left[0] - right[0]);
                const chain = longestIncreasing(anchors, pair => pair[1]);
                let previousA = aStart, previousB = bStart;
                for (const [anchorA, anchorB] of chain) {
                    recurse(previousA, anchorA, previousB, anchorB, depth + 1);
                    out.push({ type: 'equal', beforeIndex: anchorA, afterIndex: anchorB });
                    previousA = anchorA + 1; previousB = anchorB + 1;
                }
                recurse(previousA, aEnd, previousB, bEnd, depth + 1);
            }
        }
        for (let index = suffix.length - 1; index >= 0; index--) out.push(suffix[index]);
    };
    recurse(0, beforeLines.length, 0, afterLines.length, 0);
    return out;
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
        changedLineCount: 0, hunks: [], rows: [], commonPrefix: common.start, commonSuffix: common.suffix,
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
        changedLineCount, hunks: collectHunks(rows), rows, commonPrefix: common.start, commonSuffix: common.suffix,
    };
}

/** Contiguous runs of differing rows, as 1-based inclusive line ranges for direct reporting. */
function collectHunks(rows) {
    const hunks = [];
    let current = null;
    for (const row of rows) {
        if (row.type === 'equal') { current = null; continue; }
        if (!current) { current = { beforeStart: null, beforeEnd: null, afterStart: null, afterEnd: null, lines: 0, inserts: 0, deletes: 0, changes: 0 }; hunks.push(current); }
        current.lines++;
        if (row.beforeIndex !== null) current.beforeStart ??= row.beforeIndex + 1, current.beforeEnd = row.beforeIndex + 1;
        if (row.afterIndex !== null) current.afterStart ??= row.afterIndex + 1, current.afterEnd = row.afterIndex + 1;
        if (row.type === 'insert') current.inserts++;
        else if (row.type === 'delete') current.deletes++;
        else current.changes++;
    }
    return hunks;
}
