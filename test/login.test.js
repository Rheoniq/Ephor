'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loginItemTarget } = require('../src/main/login');

test('portable build uses the real exe, not the temp extraction', () => {
  assert.deepEqual(
    loginItemTarget({
      isPackaged: true,
      execPath: 'C:\\Temp\\abc\\Ephor.exe',
      portableFile: 'D:\\Apps\\Ephor 0.1.0.exe',
      appPath: 'ignored',
    }),
    { path: 'D:\\Apps\\Ephor 0.1.0.exe', args: [] },
  );
});

test('installed build uses execPath', () => {
  assert.deepEqual(
    loginItemTarget({ isPackaged: true, execPath: 'C:\\Ephor\\Ephor.exe', portableFile: undefined, appPath: 'x' }),
    { path: 'C:\\Ephor\\Ephor.exe', args: [] },
  );
});

test('development passes the app folder to electron.exe', () => {
  assert.deepEqual(
    loginItemTarget({ isPackaged: false, execPath: 'C:\\e\\electron.exe', portableFile: undefined, appPath: 'C:\\ephor' }),
    { path: 'C:\\e\\electron.exe', args: ['C:\\ephor'] },
  );
});
