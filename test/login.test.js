'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loginItemTarget } = require('../src/main/login');

test('portable build uses the real exe, not the temp extraction', () => {
  assert.deepEqual(
    loginItemTarget({
      isPackaged: true,
      execPath: 'C:\\Temp\\abc\\Huddle.exe',
      portableFile: 'D:\\Apps\\Huddle 0.1.0.exe',
      appPath: 'ignored',
    }),
    { path: 'D:\\Apps\\Huddle 0.1.0.exe', args: [] },
  );
});

test('installed build uses execPath', () => {
  assert.deepEqual(
    loginItemTarget({ isPackaged: true, execPath: 'C:\\Huddle\\Huddle.exe', portableFile: undefined, appPath: 'x' }),
    { path: 'C:\\Huddle\\Huddle.exe', args: [] },
  );
});

test('development passes the app folder to electron.exe', () => {
  assert.deepEqual(
    loginItemTarget({ isPackaged: false, execPath: 'C:\\e\\electron.exe', portableFile: undefined, appPath: 'C:\\huddle' }),
    { path: 'C:\\e\\electron.exe', args: ['C:\\huddle'] },
  );
});
