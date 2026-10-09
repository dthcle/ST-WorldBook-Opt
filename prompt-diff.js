import { diffLines } from './line-diff.js';

/** Ordered, structural input comparison; NOT a tokenizer or provider cache metric.
 * All lengths/offsets are JavaScript UTF-16 code units (including surrogate halves).
 * Messages use sorted-key canonical JSON followed by '\n', in original array order.
 * Plain text is compared verbatim. Unlike JSON content strings, displayed field
 * strings are NOT quoted or escaped. Inputs must both be strings or both arrays.
 */
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Iterative serialization avoids recursion limits. No toJSON, getters, coercion,
// sparse arrays, extra array properties, symbols, cycles, or non-finite numbers.
function canonical(value) {
    const chunks = [], active = new Set(), stack = [{ value }];
    const fail = () => { throw new TypeError('Input must contain only finite JSON values in plain objects and dense arrays'); };
    while (stack.length) {
        const task = stack.pop();
        if (own(task, 'text')) { chunks.push(task.text); continue; }
        if (own(task, 'leave')) { active.delete(task.leave); continue; }
        const item = task.value;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') {
            chunks.push(JSON.stringify(item)); continue;
        }
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) fail();
            chunks.push(JSON.stringify(item)); continue;
        }
        if (!Array.isArray(item) && !plain(item)) fail();
        if (active.has(item) || Object.getOwnPropertySymbols(item).length) fail();
        const array = Array.isArray(item), keys = Object.keys(item);
        const names = Object.getOwnPropertyNames(item);
        if (names.length !== keys.length + (array ? 1 : 0)) fail();
        if (array && (keys.length !== item.length || keys.some((key, i) => key !== String(i)))) fail();
        const ordered = array ? keys : keys.sort();
        for (const key of ordered) {
            if (!own(Object.getOwnPropertyDescriptor(item, key), 'value')) fail();
        }
        active.add(item);
        chunks.push(array ? '[' : '{');
        stack.push({ leave: item }, { text: array ? ']' : '}' });
        for (let i = ordered.length - 1; i >= 0; i--) {
            const key = ordered[i];
            stack.push({ value: Object.getOwnPropertyDescriptor(item, key).value });
            if (!array) stack.push({ text: JSON.stringify(key) + ':' });
            if (i > 0) stack.push({ text: ',' });
        }
    }
    return chunks.join('');
}

function prefix(a, b) {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}
function fieldDiff(field, beforeText, afterText, beforePresent = true, afterPresent = true) {
    const a = beforeText ?? '', b = afterText ?? '';
    const commonPrefix = prefix(a, b);
    let commonSuffix = 0;
    const limit = Math.min(a.length, b.length) - commonPrefix;
    while (commonSuffix < limit && a.charCodeAt(a.length - commonSuffix - 1) === b.charCodeAt(b.length - commonSuffix - 1)) commonSuffix++;
    return {
        field, beforeText, afterText, beforePresent, afterPresent, commonPrefix, commonSuffix,
        beforeChanged: { start: commonPrefix, end: a.length - commonSuffix },
        afterChanged: { start: commonPrefix, end: b.length - commonSuffix },
        lineDiff: diffLines(a, b),
    };
}
function prepare(messages) {
    // Validate even the outer array before reading its members.
    canonical(messages);
    let offset = 0;
    return messages.map(message => {
        if (!plain(message)) throw new TypeError('Each message must be a plain JSON object');
        const fields = new Map(), chunks = ['{'];
        let local = 1;
        for (const [i, key] of Object.keys(message).sort().entries()) {
            if (i) { chunks.push(','); local++; }
            const heading = JSON.stringify(key) + ':', value = canonical(message[key]);
            const text = typeof message[key] === 'string' ? message[key] : value;
            fields.set(key, { canonical: value, text, start: local, valueStart: local + heading.length, end: local + heading.length + value.length });
            chunks.push(heading, value);
            local += heading.length + value.length;
        }
        chunks.push('}\n');
        const text = chunks.join(''), result = { message, fields, text, offset };
        offset += text.length;
        return result;
    });
}

/**
 * Returns {kind,offsetUnit,representation,prefixCharacters,totalBefore,totalAfter,
 * firstDifference,rows}. firstDifference is null iff inputs are equal.
 * Rows preserve strict indices (no LCS/heuristic realignment): a middle insertion
 * changes subsequent paired rows; only unpaired trailing rows are inserted/deleted.
 * Each row: {index,before,after,status,fieldDiffs}; before/after reference the input
 * messages (read-only by convention), absent messages are null. Plain text has one
 * synthetic row with {content: text}. Only differing fields appear in fieldDiffs.
 * fieldDiffs expose full texts once; commonPrefix/commonSuffix are lengths;
 * beforeChanged/afterChanged are half-open ranges into those displayed texts.
 * A missing field has text=null, with *Present=false (JSON null text is 'null').
 * firstDifference: index, field, characterPosition (displayed field offset),
 * beforeCharacterPosition/afterCharacterPosition, canonicalOffset (global),
 * messageCharacterPosition (canonical row offset), and type.
 * Canonical offsets and displayed field offsets are intentionally different:
 * JSON escaping, keys and separators contribute to canonical totals/prefixes.
 * Runtime O(JSON size + key sorting); no quadratic alignment or token estimates.
 */
export function compareInputs(previous, current) {
    const textMode = typeof previous === 'string' && typeof current === 'string';
    if (!textMode && !(Array.isArray(previous) && Array.isArray(current))) {
        throw new TypeError('Both inputs must be plain text strings or both must be message arrays');
    }
    const base = {
        kind: textMode ? 'text' : 'messages', offsetUnit: 'UTF-16 code units',
        representation: textMode ? 'verbatim text' : 'sorted-key JSON per message + LF; original message order',
    };
    if (textMode) {
        const common = prefix(previous, current), equal = previous === current;
        return {
            ...base, prefixCharacters: common, totalBefore: previous.length, totalAfter: current.length,
            firstDifference: equal ? null : {
                index: 0, field: 'content', characterPosition: common,
                beforeCharacterPosition: common, afterCharacterPosition: common,
                canonicalOffset: common, messageCharacterPosition: common, type: 'changed',
            },
            rows: [{ index: 0, before: { content: previous }, after: { content: current },
                status: equal ? 'equal' : 'changed', fieldDiffs: equal ? [] : [fieldDiff('content', previous, current)] }],
        };
    }
    const before = prepare(previous), after = prepare(current);
    const beforeStream = before.map(row => row.text).join(''), afterStream = after.map(row => row.text).join('');
    const common = prefix(beforeStream, afterStream), rows = [];
    let firstDifference = null;
    for (let index = 0; index < Math.max(before.length, after.length); index++) {
        const a = before[index], b = after[index];
        const status = !a ? 'inserted' : !b ? 'deleted' : a.text === b.text ? 'equal' : 'changed';
        const fieldDiffs = [];
        const keys = [...new Set([...(a?.fields.keys() ?? []), ...(b?.fields.keys() ?? [])])].sort();
        for (const field of keys) {
            const av = a?.fields.get(field), bv = b?.fields.get(field);
            if (!av || !bv || av.canonical !== bv.canonical) {
                fieldDiffs.push(fieldDiff(field, av?.text ?? null, bv?.text ?? null, !!av, !!bv));
            }
        }
        rows.push({ index, before: a?.message ?? null, after: b?.message ?? null, status, fieldDiffs });
        if (!firstDifference && status !== 'equal') {
            const diff = fieldDiffs[0];
            // Sorted keys are canonical comparison order, not UI role/content order.
            const field = diff?.field ?? null;
            firstDifference = {
                index, field, characterPosition: diff?.commonPrefix ?? 0,
                beforeCharacterPosition: diff?.beforePresent ? diff.commonPrefix : null,
                afterCharacterPosition: diff?.afterPresent ? diff.commonPrefix : null,
                canonicalOffset: common,
                messageCharacterPosition: common - (a?.offset ?? b.offset), type: status,
            };
        }
    }
    return { ...base, prefixCharacters: common, totalBefore: beforeStream.length, totalAfter: afterStream.length, firstDifference, rows };
}
