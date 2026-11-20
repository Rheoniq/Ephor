'use strict';

// Start-at-login: which exe (and args) Windows should launch at login.
// The state itself lives only in Electron's login item settings
// (app.setLoginItemSettings / getLoginItemSettings); Huddle stores nothing.

// - Portable build: process.execPath is a temp extraction folder that changes
//   per run, so use the real exe path electron-builder exposes in
//   PORTABLE_EXECUTABLE_FILE.
// - Installed build: process.execPath is the installed exe.
// - Development (npm start): execPath is electron.exe, which needs the app
//   folder as its argument.
function loginItemTarget({ isPackaged, execPath, portableFile, appPath }) {
  if (isPackaged) return { path: portableFile || execPath, args: [] };
  return { path: execPath, args: [appPath] };
}

module.exports = { loginItemTarget };
