const GPL = /^GPL-(2|3)\.0-(only|or-later)$/;
const COMPATIBLE_WITH_GPL3 = /^(?:MIT|ISC|BSD-\d-Clause|Apache-2\.0|Zlib|0BSD|CC0-1\.0)$/;

export function classifyCapability(licenses) {
  const values = Array.isArray(licenses) ? licenses.map(value => String(value).trim()) : [];
  const copyleft = values.find(value => GPL.test(value));
  if (!copyleft) return { gpl: false, copyleft: null };
  if (values.some(value => !GPL.test(value) && !COMPATIBLE_WITH_GPL3.test(value))) return { gpl: false, copyleft: null };
  const versions = values.filter(value => GPL.test(value));
  if (versions.some(value => value.startsWith('GPL-2.0-only')) || versions.some(value => value.startsWith('GPL-3.0-only')) && versions.some(value => value.startsWith('GPL-2.0'))) return { gpl: false, copyleft: null };
  return { gpl: true, copyleft: 'GPL-3.0-or-later' };
}
