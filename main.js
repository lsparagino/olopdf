const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    frame: false,
    backgroundColor: '#0a0a14',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Lock the chrome zoom — PDF zoom is handled inside the renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
  });
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow.webContents.setZoomFactor(1);
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', false));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('dialog:open', async (_e, opts) => dialog.showOpenDialog(mainWindow, opts));
ipcMain.handle('dialog:save', async (_e, opts) => dialog.showSaveDialog(mainWindow, opts));
ipcMain.handle('fs:readFile', async (_e, p) => {
  const buf = await fs.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle('fs:writeFile', async (_e, p, data) => {
  await fs.writeFile(p, Buffer.from(data));
  return true;
});

// ----- Recents (persisted to userData/recents.json) -----
function recentsFile() {
  return path.join(app.getPath('userData'), 'recents.json');
}
async function readRecents() {
  try {
    const txt = await fs.readFile(recentsFile(), 'utf-8');
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function writeRecents(arr) {
  try { await fs.writeFile(recentsFile(), JSON.stringify(arr, null, 2)); } catch {}
}
ipcMain.handle('recents:get', async () => readRecents());
ipcMain.handle('recents:add', async (_e, filePath) => {
  const list = await readRecents();
  const next = [filePath, ...list.filter(x => x !== filePath)].slice(0, 5);
  await writeRecents(next);
  return next;
});
ipcMain.handle('recents:remove', async (_e, filePath) => {
  const list = await readRecents();
  const next = list.filter(x => x !== filePath);
  await writeRecents(next);
  return next;
});

ipcMain.on('win:min', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:max', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());
