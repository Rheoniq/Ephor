'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { encodeCwd, transcriptPath, subagentsPath } = require('../src/main/paths');

test('encodeCwd replaces every non-alphanumeric character with a dash', () => {
  assert.equal(encodeCwd('C:\\Users\\jenss\\B.R.I.A.N'), 'C--Users-jenss-B-R-I-A-N');
  assert.equal(encodeCwd('/home/a_b/my repo'), '-home-a-b-my-repo');
});

test('transcriptPath builds projects/<encoded-cwd>/<sessionId>.jsonl under home', () => {
  const p = transcriptPath('/h', 'C:\\Code\\Ephor', 'abc-123');
  assert.equal(p, path.join('/h', '.claude', 'projects', 'C--Code-Ephor', 'abc-123.jsonl'));
});

test('subagentsPath builds projects/<encoded-cwd>/<sessionId>/subagents next to the transcript', () => {
  const p = subagentsPath('/h', 'C:\\Code\\Ephor', 'abc-123');
  assert.equal(p, path.join('/h', '.claude', 'projects', 'C--Code-Ephor', 'abc-123', 'subagents'));
  assert.equal(path.dirname(path.dirname(p)), path.dirname(transcriptPath('/h', 'C:\\Code\\Ephor', 'abc-123')));
});
