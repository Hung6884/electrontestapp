// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Các kênh IPC dùng trong app (type-safe)
export type Channels =
  | 'ipc-example'
  | 'remove-background'
  | 'pick-folder'
  | 'pick-dest-folder'
  | 'batch-remove'
  | 'batch-progress'
  | 'save-batch-results'
  | 'save-processed-image'
  // NEW: device & credits
  | 'device:get'
  | 'credits:sync'
  | 'credits:use';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => func(...args);
      ipcRenderer.on(channel, subscription);
      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    invoke(channel: Channels, ...args: unknown[]) {
      return ipcRenderer.invoke(channel, ...args);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

/* =========================
 * Batch bridge: xử lý trước, lưu sau
 * ========================= */
type BatchStartOpts = { folder: string };

contextBridge.exposeInMainWorld('batch', {
  // chọn thư mục nguồn
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),

  // chọn thư mục đích khi lưu
  pickDest: (): Promise<string | null> => ipcRenderer.invoke('pick-dest-folder'),

  // bắt đầu xử lý batch -> main sẽ ghi kết quả vào thư mục TẠM và trả outDir (temp)
  start: (batchId: string, opts: BatchStartOpts): Promise<any> =>
    ipcRenderer.invoke('batch-remove', batchId, opts),

  // copy toàn bộ từ thư mục tạm sang thư mục đích đã chọn
  saveAll: (tempDir: string, dest: string, folderName?: string): Promise<any> =>
    ipcRenderer.invoke('save-batch-results', { tempDir, dest, folderName }),

  // stream tiến trình
  onProgress: (cb: (payload: any) => void) => {
    const handler = (_e: IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on('batch-progress', handler);
    return () => ipcRenderer.removeListener('batch-progress', handler);
  },
});

/* =========================
 * Save 1 ảnh đơn qua SaveDialog
 * ========================= */
contextBridge.exposeInMainWorld('saveSingle', {
  save: (dataUrl: string, defaultName?: string): Promise<any> =>
    ipcRenderer.invoke('save-processed-image', { dataUrl, defaultName }),
});

/* =========================
 * Device & Credits bridge (Node-RED)
 * ========================= */
contextBridge.exposeInMainWorld('device', {
  get: (): Promise<{ deviceId: string }> => ipcRenderer.invoke('device:get'),
});

contextBridge.exposeInMainWorld('credits', {
  // Lấy trạng thái credits hiện tại từ Node-RED
  sync: (): Promise<{
    deviceId: string;
    success: boolean;
    isRegistered: boolean;
    count: number;
    limit: number;
  }> => ipcRenderer.invoke('credits:sync'),

  // (Tuỳ chọn) nếu muốn gọi trực tiếp trong renderer: trừ 1 credit
  // Lưu ý: hiện tại app.tsx không gọi bridge này, vì main đã trừ khi 'remove-background'
  use: (): Promise<{
    ok: boolean;
    error?: string;
    deviceId?: string;
    success?: boolean;
    isRegistered?: boolean;
    count?: number;
    limit?: number;
  }> => ipcRenderer.invoke('credits:use'),
});

export type ElectronHandler = typeof electronHandler;
