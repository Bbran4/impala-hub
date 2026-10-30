import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeColor, colorToRgb, rgbToColor, chatNameColor } from '../src/colorValues.ts';

test('RGB and hex colours round-trip, including legacy milestone colours', () => {
  assert.equal(normalizeColor(' #AaBBcc '), '#aabbcc');
  assert.equal(normalizeColor('#abc'), '#aabbcc');
  assert.equal(normalizeColor('dark-blue'), '#234e70');
  assert.deepEqual(colorToRgb('#234e70'), [35, 78, 112]);
  assert.equal(rgbToColor([35, 78, 112]), '#234e70');
  for (const rgb of [[-1, 0, 0], [256, 0, 0], [1.1, 0, 0], [0, NaN, 0], [0, 0]]) assert.equal(rgbToColor(rgb), null);
  for (const hex of ['red;background:url(x)', '#ffff', '#gggggg', 'rgb(0,0,0)']) assert.equal(normalizeColor(hex), null);
});
test('chat names use assigned colours and retain a stable automatic fallback', () => {
  assert.equal(chatNameColor('employee', { employee: '#C01234' }), '#c01234');
  assert.equal(chatNameColor('employee', { employee: 'invalid' }), chatNameColor('employee'));
  assert.match(chatNameColor('employee'), /^#[0-9a-f]{6}$/);
});
