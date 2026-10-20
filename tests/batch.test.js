const test = require('node:test');
const assert = require('node:assert');

globalThis.self = globalThis;
require('../extension/src/lib/batch.js');
const { filamentSignature, groupBySignature } = self.C3MF;

const RED_PLA = { id: '1', color: '#FF0000', type: 'PLA' };
const BLUE_PLA = { id: '2', color: '#0000FF', type: 'PLA' };
const RED_PETG = { id: '1', color: '#FF0000', type: 'PETG-HF' };

const item = (name, filaments) => ({ name, analysis: { filaments } });

test('files with the same filaments and colors share one group', () => {
  const groups = groupBySignature([
    item('a', [RED_PLA, BLUE_PLA]),
    item('b', [{ ...RED_PLA }, { ...BLUE_PLA }]),
  ]);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].items.map(i => i.name), ['a', 'b']);
  assert.deepStrictEqual(groups[0].filaments, [RED_PLA, BLUE_PLA]);
});

test('different colors, types or filament count produce separate groups', () => {
  const groups = groupBySignature([
    item('a', [RED_PLA]),
    item('b', [RED_PETG]),
    item('c', [{ ...RED_PLA, color: '#00FF00' }]),
    item('d', [RED_PLA, BLUE_PLA]),
    item('e', [RED_PLA]),
  ]);
  assert.deepStrictEqual(groups.map(g => g.items.map(i => i.name)), [['a', 'e'], ['b'], ['c'], ['d']]);
});

test('filament order matters because the mapping is by filament id', () => {
  const a = filamentSignature([RED_PLA, BLUE_PLA]);
  const b = filamentSignature([{ ...BLUE_PLA, id: '1' }, { ...RED_PLA, id: '2' }]);
  assert.notStrictEqual(a, b);
});

test('color comparison ignores case', () => {
  assert.strictEqual(
    filamentSignature([{ id: '1', color: '#ff0000', type: 'PLA' }]),
    filamentSignature([RED_PLA]),
  );
});
