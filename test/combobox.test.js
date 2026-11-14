import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions } from '../public/combobox.js';

const agents = [
  { name: 'merge-lead', description: 'Merges and deploys.' },
  { name: 'pr-sweep', description: 'Reviews open PRs.' },
  { name: 'team-lead', description: 'Triages sessions and merges nothing.' },
];

test('filterOptions keeps every option, in order, for an empty or blank query', () => {
  assert.deepEqual(filterOptions(agents, ''), agents);
  assert.deepEqual(filterOptions(agents, '   '), agents);
});

test('filterOptions ranks name prefix, then name substring, then description matches', () => {
  const names = (q) => filterOptions(agents, q).map((a) => a.name);
  assert.deepEqual(names('LEAD'), ['merge-lead', 'team-lead']);
  assert.deepEqual(names('pr'), ['pr-sweep']);
  assert.deepEqual(names('merge'), ['merge-lead', 'team-lead']);
  assert.deepEqual(names('sweep'), ['pr-sweep']);
  assert.deepEqual(names('nothing-matches'), []);
});

test('filterOptions tolerates a missing description', () => {
  assert.deepEqual(filterOptions([{ name: 'bare' }], 'x'), []);
});
