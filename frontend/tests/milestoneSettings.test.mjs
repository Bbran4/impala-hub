import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserMilestones, validateMilestones } from '../src/milestoneSettings.ts';

test('milestones preserve their colours, sort numerically and support a zero GP threshold', () => {
  assert.deepEqual(validateMilestones([{ value: 15, color: '#123ABC' }, { value: 0, color: 'grey' }], 'gp'), [
    { value: 0, color: '#7b8790' }, { value: 15, color: '#123abc' },
  ]);
  assert.deepEqual(validateMilestones([], 'sales'), []);
  assert.throws(() => validateMilestones([{ value: 1, color: '#123456' }, { value: 1, color: '#abcdef' }], 'sales'), /different value/);
  for (const value of [-1, 100.01, NaN, Infinity, 1.123]) assert.throws(() => validateMilestones([{ value, color: '#123456' }], 'gp'));
  assert.throws(() => validateMilestones([{ value: 0, color: '#123456' }], 'sales'));
  assert.throws(() => validateMilestones([{ value: 1, color: 'invalid' }], 'sales'), /colour/);
});
test('browser-only targets can be explicitly imported without changing their values or colours', () => {
  const values = {
    sales_desk_gp_milestones: '[500000,100000]',
    sales_desk_gp_milestone_colors: '{"500000":"green","100000":"#123456"}',
    sales_desk_gp_percent_milestones: '[0,12.5]',
    sales_desk_gp_percent_colors: '{"12.5":"#abcdef"}',
  };
  const result = readBrowserMilestones({ getItem: (key) => values[key] ?? null });
  assert.deepEqual(result.sales, [{ value: 100000, color: '#123456' }, { value: 500000, color: '#2f9e6b' }]);
  assert.deepEqual(result.gp, [{ value: 0, color: '#234e70' }, { value: 12.5, color: '#abcdef' }]);
  assert.equal(readBrowserMilestones({ getItem: () => null }), null);
  assert.equal(readBrowserMilestones({ getItem: () => '{broken' }), null);
  assert.equal(readBrowserMilestones({ getItem: () => { throw new Error('Storage disabled'); } }), null);
});
