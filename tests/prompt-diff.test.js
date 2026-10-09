import assert from 'node:assert/strict';
import { compareInputs } from '../prompt-diff.js';

// Intentionally a single process: node tests/prompt-diff.test.js
let passed = 0;
function test(name, run) {
    try { run(); passed++; console.log(`ok ${passed} - ${name}`); }
    catch (error) { console.error(`not ok - ${name}`); throw error; }
}
const message = content => ({ role: 'user', content });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const stream = messages => messages.map(m => canonical(m) + '\n').join('');
const common = (a, b) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };

 test('empty and identical text; explicit UTF-16 label and no cache statistics', () => {
    for (const text of ['', '中文\n😀', 'a'.repeat(100000)]) {
        const result = compareInputs(text, text);
        assert.equal(result.prefixCharacters, text.length);
        assert.equal(result.totalBefore, text.length);
        assert.equal(result.totalAfter, text.length);
        assert.equal(result.firstDifference, null);
        assert.equal(result.offsetUnit, 'UTF-16 code units');
        assert.equal(result.rows[0].status, 'equal');
        assert.deepEqual(result.rows[0].fieldDiffs, []);
        assert.ok(!Object.keys(result).some(key => /token|cache|ratio/i.test(key)));
    }
});
test('Chinese, emoji and surrogate half offsets are code units, without normalization', () => {
    const result = compareInputs('中文😀末尾', '中文😁末尾');
    assert.equal(result.prefixCharacters, 3);
    assert.equal(result.firstDifference.characterPosition, 3);
    const diff = result.rows[0].fieldDiffs[0];
    assert.equal(diff.commonSuffix, 2);
    assert.deepEqual(diff.beforeChanged, { start: 3, end: 4 });
    assert.equal(compareInputs('é', 'e\u0301').prefixCharacters, 0);
});
test('text insertion/deletion and nonoverlapping prefix/suffix ranges', () => {
    for (const [a, b, p, s] of [['abc', 'abcX', 3, 0], ['abcX', 'abc', 3, 0], ['', '中', 0, 0], ['aaaa', 'aa', 2, 0], ['headXtail', 'headYtail', 4, 4]]) {
        const result = compareInputs(a, b), diff = result.rows[0].fieldDiffs[0];
        assert.equal(diff.commonPrefix, p); assert.equal(diff.commonSuffix, s);
        assert.equal(diff.beforeChanged.end, a.length - s);
        assert.equal(diff.afterChanged.end, b.length - s);
        assert.equal(result.firstDifference.canonicalOffset, p);
    }
});
test('stable nested key order, unknown metadata and role/name/tool calls preserved', () => {
    const a = [{ role: 'assistant', name: '姓名', tool_calls: [{ id: '1', function: { name: 'f', arguments: '{"a":1}' }, type: 'function' }], content: [{ type: 'text', text: '中文' }, { type: 'image_url', image_url: { url: 'data:x', detail: 'low' } }], extra: { z: 1, a: [2, 3] } }];
    const b = [{ extra: { a: [2, 3], z: 1 }, content: [{ text: '中文', type: 'text' }, { image_url: { detail: 'low', url: 'data:x' }, type: 'image_url' }], tool_calls: [{ type: 'function', function: { arguments: '{"a":1}', name: 'f' }, id: '1' }], name: '姓名', role: 'assistant' }];
    const result = compareInputs(a, b);
    assert.equal(result.firstDifference, null);
    assert.equal(result.prefixCharacters, stream(a).length);
    assert.equal(result.rows[0].before, a[0]);
    assert.equal(result.rows[0].after, b[0]);
    for (const field of ['role', 'name', 'tool_calls', 'content', 'extra']) {
        const changed = structuredClone(b); changed[0][field] = null;
        const r = compareInputs(a, changed);
        assert.equal(r.rows[0].status, 'changed');
        assert.equal(r.firstDifference.field, field);
        assert.equal(r.rows[0].fieldDiffs[0].field, field);
    }
});
test('arrays retain order and strings are displayed as raw text, not JSON literals', () => {
    const a = [message('行一\n"中文"\\')], b = [message('行一\n"世界"\\')];
    const result = compareInputs(a, b), diff = result.rows[0].fieldDiffs[0];
    assert.equal(diff.beforeText, a[0].content);
    assert.equal(diff.commonPrefix, 4);
    assert.equal(result.prefixCharacters, common(stream(a), stream(b)));
    assert.notEqual(result.firstDifference.characterPosition, result.firstDifference.messageCharacterPosition);
    const r = compareInputs([{ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }], [{ content: [{ type: 'text', text: 'b' }, { type: 'text', text: 'a' }] }]);
    assert.equal(r.rows[0].status, 'changed');
    assert.equal(r.rows[0].fieldDiffs[0].beforeText, canonical([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]));
});
test('first difference follows sent order and canonical field order, not last match', () => {
    const a = [message('same'), { role: 'user', name: 'before', content: 'A' }, message('same again')];
    const b = [message('same'), { role: 'assistant', name: 'after', content: 'B' }, message('same again')];
    const result = compareInputs(a, b);
    assert.deepEqual(result.rows.map(r => r.status), ['equal', 'changed', 'equal']);
    assert.equal(result.firstDifference.index, 1);
    assert.equal(result.firstDifference.field, 'content');
    assert.equal(result.firstDifference.canonicalOffset, common(stream(a), stream(b)));
    assert.equal(result.firstDifference.messageCharacterPosition, result.prefixCharacters - stream(a.slice(0, 1)).length);
    assert.deepEqual(result.rows[1].fieldDiffs.map(d => d.field), ['content', 'name', 'role']);
});
test('strict same-index comparison; distinguish only unpaired trailing insertion/deletion', () => {
    const a = [message('A'), message('B'), message('C')];
    const b = [message('A'), message('inserted'), message('B'), message('C')];
    assert.deepEqual(compareInputs(a, b).rows.map(r => r.status), ['equal', 'changed', 'changed', 'inserted']);
    assert.deepEqual(compareInputs(b, a).rows.map(r => r.status), ['equal', 'changed', 'changed', 'deleted']);
    const appended = compareInputs(a, [...a, message('D')]);
    assert.equal(appended.prefixCharacters, stream(a).length);
    assert.equal(appended.firstDifference.index, 3);
    assert.equal(appended.firstDifference.type, 'inserted');
    assert.equal(appended.rows[3].before, null);
    assert.equal(compareInputs([], []).firstDifference, null);
    assert.equal(compareInputs([], [{}]).firstDifference.field, null);
    assert.equal(compareInputs([{}], []).rows[0].status, 'deleted');
});
test('missing, null, empty text and different JSON types remain distinct', () => {
    for (const [a, b] of [[{}, { content: '' }], [{ content: null }, {}], [{ content: 'null' }, { content: null }], [{ content: '1' }, { content: 1 }]]) {
        const result = compareInputs([a], [b]);
        assert.equal(result.rows[0].status, 'changed');
        assert.equal(result.rows[0].fieldDiffs.length, 1);
        assert.equal(result.rows[0].fieldDiffs[0].beforePresent, Object.hasOwn(a, 'content'));
        assert.equal(result.rows[0].fieldDiffs[0].afterPresent, Object.hasOwn(b, 'content'));
    }
    assert.equal(compareInputs([{}], [{ content: null }]).rows[0].fieldDiffs[0].afterText, 'null');
});
test('reject wrong input shape, nonfinite/nonJSON, sparse and decorated arrays', () => {
    for (const value of [null, {}, 3, undefined]) assert.throws(() => compareInputs(value, value), TypeError);
    assert.throws(() => compareInputs('', []), TypeError);
    for (const bad of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), new Date(), new Map(), new Set(), /x/]) {
        assert.throws(() => compareInputs([{ content: bad }], []), TypeError);
        assert.throws(() => compareInputs([], [{ content: bad }]), TypeError);
    }
    for (const bad of [null, 'text', [], 1]) assert.throws(() => compareInputs([bad], []), TypeError);
    const sparse = []; sparse.length = 1;
    const decorated = []; decorated.extra = 1;
    const symbol = { content: 'a', [Symbol('x')]: 1 };
    const nonenumerable = {}; Object.defineProperty(nonenumerable, 'hidden', { value: 1 });
    for (const bad of [sparse, decorated]) assert.throws(() => compareInputs(bad, []), TypeError);
    for (const bad of [symbol, nonenumerable]) assert.throws(() => compareInputs([bad], []), TypeError);
});
test('no getter/toJSON execution, reject cycles but permit repeated shared values', () => {
    let calls = 0;
    const getter = {}; Object.defineProperty(getter, 'content', { enumerable: true, get() { calls++; return 'x'; } });
    const custom = { toJSON() { calls++; return {}; } };
    for (const value of [getter, custom]) assert.throws(() => compareInputs([value], []), TypeError);
    assert.equal(calls, 0);
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => compareInputs([{ content: cycle }], []), TypeError);
    const shared = { value: 1 };
    assert.equal(compareInputs([{ a: shared, b: shared }], [{ a: { value: 1 }, b: { value: 1 } }]).firstDifference, null);
    const nullProto = Object.assign(Object.create(null), { content: 'a' });
    assert.equal(compareInputs([nullProto], [{ content: 'a' }]).firstDifference, null);
});
test('frozen inputs stay untouched; deep structures use iterative serialization', () => {
    const a = Object.freeze([Object.freeze({ role: 'user', content: 'A' })]);
    const b = Object.freeze([Object.freeze({ role: 'user', content: 'B' })]);
    compareInputs(a, b);
    assert.equal(a[0].content, 'A'); assert.equal(b[0].content, 'B');
    let deep = 'leaf'; for (let i = 0; i < 12000; i++) deep = { a: deep };
    assert.equal(compareInputs([{ content: deep }], [{ content: deep }]).firstDifference, null);
});
test('500 messages / ~100k characters: full prefix oracle, no copied changed strings', () => {
    const a = Array.from({ length: 500 }, (_, i) => message(`${i}:` + '中文'.repeat(100)));
    const b = structuredClone(a); b[499].content += '变化';
    const start = performance.now(), result = compareInputs(a, b), elapsed = performance.now() - start;
    assert.equal(result.firstDifference.index, 499);
    assert.equal(result.prefixCharacters, common(stream(a), stream(b)));
    assert.equal(result.totalBefore, stream(a).length);
    assert.equal(result.totalAfter, stream(b).length);
    assert.equal(result.rows.length, 500);
    const diff = result.rows[499].fieldDiffs[0];
    assert.deepEqual(diff.beforeChanged, { start: a[499].content.length, end: a[499].content.length });
    assert.deepEqual(diff.afterChanged, { start: a[499].content.length, end: b[499].content.length });
    assert.ok(elapsed < 10000, `Unexpectedly slow comparison: ${elapsed}ms`);
    console.log(`  500-message benchmark: ${elapsed.toFixed(1)}ms`);
});
test('deterministic varied JSON messages agree with independent canonical prefix oracle', () => {
    for (let i = 0; i < 80; i++) {
        const a = [{ role: 'user', content: `中文${i}\n`, z: { b: [null, true, i], a: '"' } }, {}];
        const b = structuredClone(a);
        if (i % 4 === 0) b[0].z.b.reverse();
        else if (i % 4 === 1) b[0].newField = i;
        else if (i % 4 === 2) delete b[0].content;
        else b.push({ role: 'assistant', content: '新' });
        const result = compareInputs(a, b);
        assert.equal(result.prefixCharacters, common(stream(a), stream(b)));
        assert.equal(result.totalBefore, stream(a).length);
        assert.equal(result.totalAfter, stream(b).length);
    }
});
console.log(`Passed ${passed} prompt-diff tests.`);
