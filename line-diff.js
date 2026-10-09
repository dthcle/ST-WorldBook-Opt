/** Line-oriented refinement for prompt fields. Pure, dependency-free, no token metric.
 * The goal is a directly readable diff: which lines changed, and what changed inside them.
 * Alignment uses range-local patience anchors and budgeted Myers fallback. Patience anchors
 * and the emergency greedy fallback do NOT guarantee a globally minimal edit script.
 * All offsets are UTF-16 units; no percentage here claims an exact similarity metric.
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

function countLines(lines, start, end) {
    const counts = new Map();
    for (let i = start; i < end; i++) counts.set(lines[i], (counts.get(lines[i]) ?? 0) + 1);
    return counts;
}

// Both work and trace storage are shared across all fallback regions in one alignment.
// No N*M matrix: Myers keeps O(D²) trace cells, stopped at a fixed memory/work budget.
const MAX_FALLBACK_WORK = 4_000_000;
const MAX_TRACE_CELLS = 1_000_000;
function myersMatches(a, aStart, aEnd, b, bStart, bEnd, budget) {
    const n = aEnd - aStart, m = bEnd - bStart, trace = [];
    const get = (v, d, k) => k < -d || k > d ? -Infinity : v[k + d];
    for (let d = 0; d <= n + m; d++) {
        const cells = 2 * d + 1;
        if (budget.cells < cells || budget.work <= 0) return null;
        budget.cells -= cells;
        const v = new Int32Array(cells);
        v.fill(-1);
        const prev = trace[d - 1];
        for (let k = -d; k <= d; k += 2) {
            if (--budget.work < 0) return null;
            let x = d === 0 ? 0 : (k === -d || (k !== d && get(prev, d - 1, k - 1) < get(prev, d - 1, k + 1)))
                ? get(prev, d - 1, k + 1) : get(prev, d - 1, k - 1) + 1;
            let y = x - k;
            while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
                if (--budget.work < 0) return null;
                x++; y++;
            }
            v[k + d] = x;
            if (x >= n && y >= m) {
                const matches = [];
                for (let distance = d; distance > 0; distance--) {
                    const prior = trace[distance - 1], diagonal = x - y;
                    const priorK = diagonal === -distance || (diagonal !== distance &&
                        get(prior, distance - 1, diagonal - 1) < get(prior, distance - 1, diagonal + 1))
                        ? diagonal + 1 : diagonal - 1;
                    const priorX = get(prior, distance - 1, priorK), priorY = priorX - priorK;
                    while (x > priorX && y > priorY) {
                        matches.push([aStart + --x, bStart + --y]);
                    }
                    x = priorX; y = priorY;
                }
                while (x > 0 && y > 0) matches.push([aStart + --x, bStart + --y]);
                return matches.reverse();
            }
        }
        trace.push(v);
    }
    return null;
}

// Emergency monotone matching costs O(N + M) space and O(N log M) time. It still
// preserves equal content, but may miss a better alignment. Callers get budgetExceeded.
function greedyMatches(a, aStart, aEnd, b, bStart, bEnd) {
    const positions = new Map(), matches = [];
    for (let j = bStart; j < bEnd; j++) {
        if (!positions.has(b[j])) positions.set(b[j], []);
        positions.get(b[j]).push(j);
    }
    let next = bStart;
    for (let i = aStart; i < aEnd; i++) {
        const candidates = positions.get(a[i]);
        if (!candidates) continue;
        let low = 0, high = candidates.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (candidates[mid] < next) low = mid + 1; else high = mid;
        }
        if (low < candidates.length) {
            matches.push([i, candidates[low]]);
            next = candidates[low] + 1;
        }
    }
    return matches;
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
 * Patience alignment counts uniqueness in each current range, recurses between LIS anchors,
 * and uses budgeted Myers for unanchored regions (including repeated equal lines).
 * `change` is only a small-gap display pairing of one deletion and one insertion.
 * Optional budgets support deterministic limit tests; stats reports emergency approximation.
 */
export function alignLines(beforeLines, afterLines, {
    maxFallbackWork = MAX_FALLBACK_WORK, maxTraceCells = MAX_TRACE_CELLS, stats = {},
} = {}) {
    const budget = { work: maxFallbackWork, cells: maxTraceCells };
    stats.budgetExceeded = false;
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
    const fallback = (aStart, aEnd, bStart, bEnd) => {
        // Disjoint alphabets need no search, regardless of the region's size.
        const content = new Set(beforeLines.slice(aStart, aEnd));
        let shared = false;
        for (let j = bStart; j < bEnd; j++) if (content.has(afterLines[j])) { shared = true; break; }
        if (!shared) { pairUp(aStart, aEnd, bStart, bEnd); return; }
        let matches = myersMatches(beforeLines, aStart, aEnd, afterLines, bStart, bEnd, budget);
        if (matches === null) {
            stats.budgetExceeded = true;
            matches = greedyMatches(beforeLines, aStart, aEnd, afterLines, bStart, bEnd);
        }
        let previousA = aStart, previousB = bStart;
        for (const [i, j] of matches) {
            pairUp(previousA, i, previousB, j);
            out.push({ type: 'equal', beforeIndex: i, afterIndex: j });
            previousA = i + 1; previousB = j + 1;
        }
        pairUp(previousA, aEnd, previousB, bEnd);
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
            fallback(aStart, aEnd, bStart, bEnd);
        } else {
            const beforeCount = countLines(beforeLines, aStart, aEnd);
            const afterCount = countLines(afterLines, bStart, bEnd);
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
                fallback(aStart, aEnd, bStart, bEnd);
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
 * changedLineCount = deleteCount + insertCount; a visual 'change' counts as TWO edits.
 * replaceCount counts display pairs (already included in both deleteCount and insertCount).
 * Hunk lines/inserts/deletes/changes retain their original display-row semantics.
 * Alignment is not a globally minimal edit guarantee; do not infer an exact percentage.
 */
export function diffLines(before, after, { maxChars = MAX_CHARS, maxLines = MAX_LINES } = {}) {
    const a = before ?? '', b = after ?? '';
    const common = commonEnds(a, b);
    const beforeLines = splitLines(a), afterLines = splitLines(b);
    const unsupported = reason => ({
        supported: false, reason, beforeLineCount: beforeLines.length, afterLineCount: afterLines.length,
        changedLineCount: 0, insertCount: 0, deleteCount: 0, replaceCount: 0, matched: 0,
        algorithm: 'range-patience/budgeted-myers', minimalGuaranteed: false, budgetExceeded: false,
        hunks: [], rows: [], commonPrefix: common.start, commonSuffix: common.suffix,
    });
    if (a.length + b.length > maxChars) return unsupported('文本过大，未逐行对比。');
    if (beforeLines.length + afterLines.length > maxLines) return unsupported('行数过多，未逐行对比。');

    const stats = {};
    const aligned = alignLines(beforeLines, afterLines, { stats });
    let insertCount = 0, deleteCount = 0, replaceCount = 0, matched = 0;
    const rows = aligned.map(row => {
        const beforeText = row.beforeIndex === null ? null : beforeLines[row.beforeIndex];
        const afterText = row.afterIndex === null ? null : afterLines[row.afterIndex];
        if (row.type === 'equal') matched++;
        else {
            if (row.beforeIndex !== null) deleteCount++;
            if (row.afterIndex !== null) insertCount++;
            if (row.type === 'change') replaceCount++;
        }
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
        changedLineCount: deleteCount + insertCount, insertCount, deleteCount, replaceCount, matched,
        algorithm: 'range-patience/budgeted-myers', minimalGuaranteed: false, budgetExceeded: stats.budgetExceeded,
        hunks: collectHunks(rows), rows, commonPrefix: common.start, commonSuffix: common.suffix,
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
