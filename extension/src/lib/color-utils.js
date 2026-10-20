self.C3MF = self.C3MF || {};

/**
 * Normalize a color string to #RRGGBB format (uppercase, no alpha).
 * Port of normalize_color() from app.py:97-109.
 */
self.C3MF.normalizeColor = function(color) {
  if (!color) return '#000000';
  let c = color.replace(/^#/, '');
  if (c.length === 8) c = c.slice(0, 6); // strip alpha
  if (c.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(c)) return '#000000';
  return '#' + c.toUpperCase();
};

/**
 * Convert a #RRGGBB color to #RRGGBBFF (uppercase, with alpha).
 */
self.C3MF.toRGBA = function(hex) {
  const c = hex.startsWith('#') ? hex : '#' + hex;
  return (c.length === 7 ? c + 'FF' : c).toUpperCase();
};
