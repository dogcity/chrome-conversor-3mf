const test = require('node:test');
const assert = require('node:assert');

globalThis.self = globalThis;
require('../extension/src/lib/filename.js');
const { uniqueFilename } = self.MWU1;

test('keeps the name when it is not taken', () => {
  assert.strictEqual(uniqueFilename('model-A1.3mf', new Set()), 'model-A1.3mf');
});

test('appends 2, 3, 4... while the name is taken', () => {
  assert.strictEqual(uniqueFilename('model-A1.3mf', new Set(['model-A1.3mf'])), 'model-A1-2.3mf');
  assert.strictEqual(
    uniqueFilename('model-A1.3mf', new Set(['model-A1.3mf', 'model-A1-2.3mf', 'model-A1-3.3mf'])),
    'model-A1-4.3mf',
  );
});

test('name comparison ignores case, like the macOS file system', () => {
  assert.strictEqual(uniqueFilename('Model-A1.3mf', new Set(['model-a1.3mf'])), 'Model-A1-2.3mf');
});
