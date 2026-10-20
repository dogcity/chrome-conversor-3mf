self.C3MF = self.C3MF || {};

/**
 * Build a key identifying a file's filament configuration.
 * Order matters: the slot mapping is keyed by filament id, so two files can only
 * share one mapping when the same id carries the same type and color in both.
 */
self.C3MF.filamentSignature = function(filaments) {
  return filaments
    .map(f => `${f.id}|${(f.type || '').toUpperCase()}|${(f.color || '').toUpperCase()}`)
    .join(';');
};

/**
 * Group analyzed files that share an identical filament configuration.
 * Groups keep first-appearance order, and files keep their order within a group.
 *
 * @param {Array<{analysis: {filaments: Array}}>} items
 * @returns {Array<{filaments: Array, items: Array}>}
 */
self.C3MF.groupBySignature = function(items) {
  const groups = new Map();
  for (const item of items) {
    const key = self.C3MF.filamentSignature(item.analysis.filaments);
    if (!groups.has(key)) groups.set(key, { filaments: item.analysis.filaments, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
};
