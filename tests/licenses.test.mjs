import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyCapability } from '../scripts/licenses.mjs';

test('runtime license aggregation follows component identifiers, not file headers', () => {
  assert.deepEqual(classifyCapability(['GPL-3.0-or-later', 'GPL-2.0-or-later', 'MIT']), { gpl: true, copyleft: 'GPL-3.0-or-later' });
  assert.deepEqual(classifyCapability(['BSD-2-Clause', 'ISC']), { gpl: false, copyleft: null });
  assert.deepEqual(classifyCapability(['GPL-2.0-only', 'GPL-3.0-or-later']), { gpl: false, copyleft: null });
});
