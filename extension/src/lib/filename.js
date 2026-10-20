self.C3MF = self.C3MF || {};

/**
 * Return `desired`, or `name-2.ext`, `name-3.ext`... when that name is already taken.
 * @param {string} desired - e.g. "model-A1.3mf"
 * @param {Set<string>} taken - existing file names (any case)
 */
self.C3MF.uniqueFilename = function(desired, taken) {
  const lower = new Set([...taken].map(n => n.toLowerCase()));
  if (!lower.has(desired.toLowerCase())) return desired;
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  let n = 2;
  while (lower.has(`${stem}-${n}${ext}`.toLowerCase())) n++;
  return `${stem}-${n}${ext}`;
};
