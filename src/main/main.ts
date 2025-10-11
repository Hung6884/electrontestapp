/* eslint global-require: off, no-console: off, promise/always-return: off */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import fetch from 'node-fetch';
import FormData from 'form-data';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

/* =========================
 *  Constants & Utils
 * ========================= */
const NODERED_BASE = 'https://fastexapp.vtgo.vn'; // không có trailing slash
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const isImage = (p: string) => IMAGE_EXTS.has(path.extname(p).toLowerCase());
const ensureDir = (p: string) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};
const mimeOf = (p: string) => {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
};

/* =========================
 *  DeviceId (MAC) helpers
 * ========================= */
const DEVICE_FILE = 'device.json';
const deviceFilePath = () => path.join(app.getPath('userData'), DEVICE_FILE);

function pickPrimaryMac(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni || ni.internal) continue;
      if ((ni as any).family === 'IPv4' && (ni as any).mac && !/^00:00:00:00:00:00$/i.test((ni as any).mac)) {
        return (ni as any).mac.toLowerCase();
      }
    }
  }
  return null;
}
function loadDeviceId(): string | null {
  try {
    const p = deviceFilePath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return raw?.deviceId || null;
  } catch {
    return null;
  }
}
function saveDeviceId(deviceId: string) {
  ensureDir(path.dirname(deviceFilePath()));
  fs.writeFileSync(deviceFilePath(), JSON.stringify({ deviceId }, null, 2));
}
function ensureDeviceId(): string {
  let id = loadDeviceId();
  if (id) return id;
  const mac = pickPrimaryMac();
  id = mac || `uuid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // fallback
  saveDeviceId(id);
  return id;
}

/* =========================
 *  Node-RED API helpers
 * ========================= */
async function apiGetDeviceInfo(deviceId: string) {
  const url = `${NODERED_BASE}/api/device-info/${encodeURIComponent(deviceId)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
  return json as { success: boolean; isRegistered: boolean; count: number; limit: number };
}

async function apiUseCredit(deviceId: string) {
  const url = `${NODERED_BASE}/api/use-credit`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const msg = json?.message || 'NO_CREDIT';
    const e: any = new Error(msg);
    e.code = 'NO_CREDIT';
    throw e;
  }
  if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
  return json as { success: true; message: string };
}

/* =========================
 *  IPC Simple test
 * ========================= */
ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

/* =========================
 *  IPC: Device & Credits
 * ========================= */
ipcMain.handle('device:get', async () => {
  const id = ensureDeviceId();
  return { deviceId: id };
});

ipcMain.handle('credits:sync', async () => {
  const id = ensureDeviceId();
  const info = await apiGetDeviceInfo(id);
  return { deviceId: id, ...info };
});

ipcMain.handle('credits:use', async () => {
  const id = ensureDeviceId();
  try {
    await apiUseCredit(id);
    const info = await apiGetDeviceInfo(id);
    return { ok: true, deviceId: id, ...info };
  } catch (e: any) {
    if (e?.code === 'NO_CREDIT') return { ok: false, error: 'NO_CREDIT' };
    return { ok: false, error: e?.message || 'USE_CREDIT_FAILED' };
  }
});

/* =========================
 *  Single Image Remove
 * ========================= */
ipcMain.handle('remove-background', async (_event, imageData: string) => {
  const deviceId = ensureDeviceId(); // hàm bạn đã có sẵn
  try {
    // 1️⃣ Gọi Node-RED để trừ lượt và lấy count mới
    const res = await fetch(`${NODERED_BASE}/api/use-credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });

    const info = await res.json(); // { success, count, ... }

    if (res.status === 403 || info?.success === false) {
      throw new Error(info?.message || 'NO_CREDIT');
    }

    // 2️⃣ Nếu trừ lượt thành công, xử lý ảnh
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const formData = new FormData();
    formData.append('image_file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

    const response = await fetch('http://103.133.224.221:9001/remove-and-add-background', {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    });

    if (!response.ok) throw new Error(`API error: ${response.statusText}`);

    const buffer2 = await response.buffer();
    const base64Image = `data:image/png;base64,${buffer2.toString('base64')}`;

    // 3️⃣ Trả lại renderer: ảnh + số credits mới
    return { success: true, data: base64Image, credits: info.count };
  } catch (error: any) {
    console.error('Error removing background:', error);
    return {
      success: false,
      error: error?.message || 'Unknown error',
    };
  }
});

/* =========================
 *  Folder pickers
 * ========================= */
ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});
ipcMain.handle('pick-dest-folder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

/* =========================
 *  Batch Remove
 *  - Trừ 1 credit / ảnh
 *  - Hết credit => đánh dấu skipped (NO_CREDIT)
 * ========================= */
ipcMain.handle(
  'batch-remove',
  async (event, batchId: string, opts: { folder: string; out?: string; overwrite?: boolean }) => {
    try {
      const folder = opts.folder;
      const tempDir = path.join(app.getPath('temp'), 'bgremover', batchId);
      ensureDir(tempDir);

      const files = fs
        .readdirSync(folder)
        .map((n) => path.join(folder, n))
        .filter(isImage);

      let done = 0;
      const total = files.length;

      for (const filePath of files) {
        const outPath = path.join(
          tempDir,
          path.basename(filePath).replace(/\.(jpg|jpeg|png|webp)$/i, '') + '_removed.png'
        );

        // 1) Trừ credit cho từng file
        try {
          await apiUseCredit(ensureDeviceId());
        } catch (e: any) {
          done++;
          const isNoCredit = e?.code === 'NO_CREDIT';
          event.sender.send('batch-progress', {
            batchId,
            filePath,
            status: isNoCredit ? 'skipped' : 'error',
            error: isNoCredit ? 'NO_CREDIT' : (e?.message || 'USE_CREDIT_FAILED'),
            done,
            total,
          });
          // Hết credit: skip các file còn lại (tiếp tục vòng lặp để hiển thị rõ ràng)
          continue;
        }

        try {
          // 2) Gọi API xoá nền
          const buf = fs.readFileSync(filePath);
          const filename = path.basename(filePath);
          const contentType = mimeOf(filePath);

          const sendOnce = async (fieldName: 'image_file' | 'image') => {
            const fd = new FormData();
            fd.append(fieldName, buf, { filename, contentType });
            const res = await fetch('http://103.133.224.221:9001/remove-and-add-background', {
              method: 'POST',
              body: fd,
              headers: (fd as any).getHeaders?.() || {},
            });
            return res;
          };

          let res = await sendOnce('image_file');
          if (res.status === 400) {
            try {
              res = await sendOnce('image');
            } catch {}
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`API error: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
          }

          const outBuf = await res.buffer();
          ensureDir(path.dirname(outPath));
          fs.writeFileSync(outPath, outBuf);

          done++;
          event.sender.send('batch-progress', {
            batchId,
            filePath,
            outPath,
            status: 'ok',
            done,
            total,
          });
        } catch (err: any) {
          done++;
          event.sender.send('batch-progress', {
            batchId,
            filePath,
            status: 'error',
            error: err?.message || String(err),
            done,
            total,
          });
        }
      }
       const info = await apiGetDeviceInfo(ensureDeviceId()).catch(() => null);
      return { success: true, total, outDir: tempDir, isTemp: true, credits: info?.count };
    } catch (error: any) {
      console.error('batch-remove error:', error);
      return { success: false, error: error?.message || String(error) };
    }
  }
);

/* =========================
 *  Save helpers
 * ========================= */
ipcMain.handle('save-batch-results', async (_e, payload: { tempDir: string; dest: string; folderName?: string }) => {
  try {
    const { tempDir, dest, folderName } = payload;

    if (!tempDir || !fs.existsSync(tempDir)) {
      return { success: false, error: `Thư mục tạm không tồn tại: ${tempDir}` };
    }
    if (!dest || !fs.existsSync(dest)) {
      return { success: false, error: `Thư mục đích không tồn tại hoặc không chọn được: ${dest}` };
    }

    const safeName =
      (folderName && folderName.trim()) ||
      `BG_Removed_${new Date().toISOString().replace(/[:.]/g, '-')}`;

    const targetDir = path.join(dest, safeName);
    ensureDir(targetDir);

    const entries = fs.readdirSync(tempDir);
    const files = entries
      .map((n) => path.join(tempDir, n))
      .filter((p) => fs.statSync(p).isFile());

    if (files.length === 0) {
      return { success: false, error: 'Không tìm thấy file đã xử lý trong thư mục tạm.' };
    }

    let copied = 0;
    for (const fp of files) {
      const to = path.join(targetDir, path.basename(fp));
      fs.copyFileSync(fp, to);
      copied++;
    }
    return { success: true, copied, dest: targetDir };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('save-processed-image', async (_e, payload: { dataUrl: string; defaultName?: string }) => {
  try {
    const { dataUrl, defaultName = 'removed-background.png' } = payload;
    const res = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { success: false, canceled: true };
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(res.filePath, Buffer.from(base64, 'base64'));
    return { success: true, path: res.filePath };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
});

/* =========================
 *  App bootstrap
 * ========================= */
if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name: any) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      webSecurity: false,
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) throw new Error('"mainWindow" is not defined');
    if (process.env.START_MINIMIZED) mainWindow.minimize();
    else mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // eslint-disable-next-line
  new AppUpdater();
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app
  .whenReady()
  .then(() => {
    // Khởi tạo deviceId sớm (ghi file userData nếu chưa có)
    ensureDeviceId();
    createWindow();
    app.on('activate', () => {
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
