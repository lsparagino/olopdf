const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

// ----- Startup diagnostics -----
// On a target machine the app may exit before the window ever appears (renderer crash,
// GPU init failure, AV interference). Persist a log to userData so the failure is recoverable.
const logFile = path.join(app.getPath('userData'), 'startup.log');
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(p => p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  try { fsSync.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}
  try { fsSync.appendFileSync(logFile, line); } catch {}
  try { process.stderr.write(line); } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));

log('--- launch ---', 'electron', process.versions.electron, 'chrome', process.versions.chrome, 'node', process.versions.node, 'platform', process.platform, process.arch);
log('exec', process.execPath);
log('userData', app.getPath('userData'));
log('temp', app.getPath('temp'));

// Opt-in GPU disable: if a flag file exists in userData, run with software rendering.
// Same effect as launching from a CMD with `set ELECTRON_DISABLE_GPU=1`.
const gpuFlagFile = path.join(app.getPath('userData'), 'disable-gpu');
if (process.env.ELECTRON_DISABLE_GPU === '1' || fsSync.existsSync(gpuFlagFile)) {
  log('hardware acceleration disabled via flag');
  app.disableHardwareAcceleration();
}

app.on('gpu-process-crashed', (_e, killed) => log('gpu-process-crashed killed=', killed));
app.on('child-process-gone', (_e, details) => log('child-process-gone', details));

let mainWindow;

function createWindow() {
  log('createWindow');
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

  // Fallback: show after 5s even if ready-to-show never fires, so the user can see
  // something rather than a phantom Task Manager entry.
  let shown = false;
  const showOnce = (reason) => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    log('show window:', reason);
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', () => showOnce('ready-to-show'));
  setTimeout(() => showOnce('timeout-fallback'), 5000);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  mainWindow.webContents.on('render-process-gone', (_e, details) => log('render-process-gone', details));
  mainWindow.webContents.on('unresponsive', () => log('renderer unresponsive'));
  mainWindow.webContents.on('preload-error', (_e, p, err) => log('preload-error', p, err));
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('renderer console', level, message, sourceId + ':' + line);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    log('loadURL', devUrl);
    mainWindow.loadURL(devUrl).catch(err => log('loadURL failed', err));
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else if (process.env.LEGACY_RENDERER === '1') {
    const indexPath = path.join(__dirname, 'renderer', 'index.html');
    log('loadFile (legacy)', indexPath);
    mainWindow.loadFile(indexPath).catch(err => log('loadFile failed', err));
  } else {
    const indexPath = path.join(__dirname, 'dist-renderer', 'index.html');
    log('loadFile', indexPath);
    mainWindow.loadFile(indexPath).catch(err => log('loadFile failed', err));
  }

  // Lock the chrome zoom — PDF zoom is handled inside the renderer
  mainWindow.webContents.on('did-finish-load', () => {
    log('did-finish-load');
    mainWindow.webContents.setZoomFactor(1);
  });
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow.webContents.setZoomFactor(1);
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', false));
}

app.whenReady().then(createWindow).catch(err => log('whenReady failed', err));
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
