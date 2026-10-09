import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLines, alignLines, diffLines } from '../line-diff.js';

test('splitLines keeps empty input empty and preserves blank lines', () => {
    assert.deepEqual(splitLines(''), []);
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\n\nb'), ['a', '', 'b']);
    assert.deepEqual(splitLines('a\n'), ['a', '']);
    assert.throws(() => splitLines(null), /字符串/);
});

test('alignLines pairs equal lines and marks changes in place', () => {
    const rows = alignLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    assert.deepEqual(rows.map(r => r.type), ['equal', 'change', 'equal']);
    assert.equal(rows[1].beforeIndex, 1);
    assert.equal(rows[1].afterIndex, 1);
});

test('alignLines detects inserted and deleted lines', () => {
    const inserted = alignLines(['a', 'c'], ['a', 'b', 'c']);
    assert.deepEqual(inserted.map(r => r.type), ['equal', 'insert', 'equal']);
    assert.equal(inserted[1].afterIndex, 1);
    const deleted = alignLines(['a', 'b', 'c'], ['a', 'c']);
    assert.deepEqual(deleted.map(r => r.type), ['equal', 'delete', 'equal']);
});

test('diffLines reports which lines changed with intra-line ranges', () => {
    const before = ['header', '温度：-32℃', 'footer'].join('\n');
    const after = ['header', '温度：-33℃', 'footer'].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.supported, true);
    assert.equal(diff.beforeLineCount, 3);
    assert.equal(diff.changedLineCount, 1);
    const changed = diff.rows.filter(r => r.type === 'change');
    assert.equal(changed.length, 1);
    assert.equal(changed[0].beforeText, '温度：-32℃');
    assert.equal(changed[0].afterText, '温度：-33℃');
    assert.equal(changed[0].beforeText.slice(changed[0].beforeChanged.start, changed[0].beforeChanged.end), '2');
    assert.equal(changed[0].afterText.slice(changed[0].afterChanged.start, changed[0].afterChanged.end), '3');
});

test('diffLines marks add/remove rows with null side text', () => {
    const diff = diffLines('a\nb', 'a\nb\nc');
    const inserted = diff.rows.filter(r => r.type === 'insert');
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].beforeText, null);
    assert.equal(inserted[0].afterText, 'c');
    assert.equal(diff.changedLineCount, 1);
});

test('diffLines does not flag a wrapper id line as the whole block', () => {
    // Regression for the reported case: one marker line differs, everything else is stable.
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}: 稳定内容`);
    const before = ['§§TH_SQUASH_WI:aaa:START§§', ...body, '§§TH_SQUASH_WI:aaa:END§§'].join('\n');
    const after = ['§§TH_SQUASH_WI:bbb:START§§', ...body, '§§TH_SQUASH_WI:bbb:END§§'].join('\n');
    const diff = diffLines(before, after);
    assert.equal(diff.changedLineCount, 2, 'only the two marker lines changed');
    assert.equal(diff.rows.filter(r => r.type === 'equal').length, 200);
});

test('diffLines stays bounded for very large inputs', () => {
    const big = 'x'.repeat(5000);
    const huge = Array.from({ length: 400 }, () => big).join('\n');
    const diff = diffLines(huge, `${huge}y`);
    assert.equal(diff.supported, false);
    assert.match(diff.reason, /过大|行数过多/);
});

test('diffLines treats identical text as all-equal', () => {
    const diff = diffLines('a\nb\nc', 'a\nb\nc');
    assert.equal(diff.changedLineCount, 0);
    assert.equal(diff.rows.every(r => r.type === 'equal'), true);
});

test('diffLines handles empty sides', () => {
    assert.equal(diffLines('', '').changedLineCount, 0);
    const added = diffLines('', 'a\nb');
    assert.equal(added.changedLineCount, 2);
    const removed = diffLines('a\nb', '');
    assert.equal(removed.changedLineCount, 2);
});

test('line alignment survives a shift larger than the lookahead by falling back to changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i}`);
    const after = ['new1', 'new2', ...before];
    const diff = diffLines(before.join('\n'), after.join('\n'));
    assert.equal(diff.supported, true);
    // The 20 stable lines must still be recognised as equal despite the 2-line shift.
    assert.equal(diff.rows.filter(r => r.type === 'equal').length, 20);
    assert.equal(diff.changedLineCount, 2);
});
