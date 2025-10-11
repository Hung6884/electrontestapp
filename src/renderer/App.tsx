import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

/** =========================
 *  Utils chỉ dùng cho renderer
 *  ========================= */
declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        sendMessage: (channel: any, ...args: any[]) => void;
        on: (channel: any, func: (...args: any[]) => void) => () => void;
        once: (channel: any, func: (...args: any[]) => void) => void;
        invoke: (channel: any, ...args: any[]) => Promise<any>;
      };
    };
    device?: {
      get: () => Promise<{ deviceId: string }>;
    };
    credits?: {
      sync: () => Promise<{
        deviceId: string;
        success: boolean;
        isRegistered: boolean;
        count: number;
        limit: number;
      }>;
    };
    batch?: {
      pickFolder: () => Promise<string | null>;
      pickDest: () => Promise<string | null>;
      start: (batchId: string, opts: { folder: string }) => Promise<any>;
      saveAll: (tempDir: string, dest: string, folderName?: string) => Promise<any>;
      onProgress: (cb: (p: any) => void) => () => void;
    };
    saveSingle?: {
      save: (dataUrl: string, defaultName?: string) => Promise<any>;
    };
  }
}

const toFileUrl = (p: string) => `file://${p.replace(/\\/g, '/')}`;
const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;
const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** =========================
 *  Paywall
 *  ========================= */
function Paywall({
  open,
  onClose,
  onReload,
  deviceId,
}: {
  open: boolean;
  onClose: () => void;
  onReload: () => void;
  deviceId?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-2xl p-5 w-[420px]">
        <h3 className="text-lg font-semibold mb-2">Hết lượt sử dụng</h3>
        <p className="text-sm mb-3">
          Bạn đã dùng hết <b>10 lượt thử</b>. Nạp qua <b>VietQR</b> (1.000đ / 1 lượt).<br />
          <b>Nội dung chuyển khoản</b>: <code>{deviceId || 'device-id'}</code>. Sau khi admin xác nhận,
          bấm “Làm mới” để cập nhật.
        </p>
        <div className="grid gap-2">
          <button className="btn primary" onClick={onReload}>
            🔄 Làm mới
          </button>
          <button className="btn" onClick={onClose}>
            Để sau
          </button>
        </div>
      </div>
    </div>
  );
}

/** =========================
 *  Component: Xoá nền 1 ảnh
 *  ========================= */
function BackgroundRemover() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // NEW: device & credits & paywall
  const [deviceId, setDeviceId] = useState<string>('');
  const [credits, setCredits] = useState<number>(0);
  const [paywallOpen, setPaywallOpen] = useState(false);

  // Auto-scroll to bottom when new content appears
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [selectedImage, processedImage, error]);

  // Load device & credits khi mở app
  useEffect(() => {
    (async () => {
      try {
        const dev = await (window as any).device?.get?.();
        if (dev?.deviceId) setDeviceId(dev.deviceId);

        const info = await (window as any).credits?.sync?.();
        if (typeof info?.count === 'number') setCredits(info.count);
      } catch (e) {
        console.error('Failed to load device or credits info', e);
      }
    })();
  }, []);

  const readFileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleImageSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileToDataUrl(file);
      setSelectedImage(dataUrl);
      setProcessedImage(null);
      setError(null);
    } catch (e) {
      setError('Không đọc được ảnh đã chọn');
    }
  };

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileToDataUrl(file);
      setSelectedImage(dataUrl);
      setProcessedImage(null);
      setError(null);
    } catch {
      setError('Không đọc được ảnh đã thả');
    }
  }, []);

  const removeBackground = async () => {
    if (!selectedImage) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke('remove-background', selectedImage);

      if (result?.success) {
        setProcessedImage(result.data);

        // 👉 cập nhật số dư ngay nếu main trả credits
        if (typeof result.credits === 'number') {
          setCredits(result.credits);
        } else {
          // fallback: flow Node-RED cũ chưa trả count → sync lại
          const info = await (window as any).credits?.sync?.();
          if (typeof info?.count === 'number') setCredits(info.count);
        }
      } else {
        // hết lượt
        if (String(result?.error).includes('NO_CREDIT')) {
          setPaywallOpen(true); // ★ bật paywall khi hết lượt
          setError('Bạn đã hết số lần sử dụng. Vui lòng nạp thêm để tiếp tục.');
          const info = await (window as any).credits?.sync?.();
          if (typeof info?.count === 'number') setCredits(info.count);
        } else {
          setError(result?.error || 'Xử lý thất bại');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra');
    } finally {
      setIsProcessing(false);
    }
  };

  // SaveDialog thay cho tự tải xuống
  const saveProcessed = async () => {
    if (!processedImage) return;
    await window.saveSingle?.save(processedImage, 'removed-background.png');
  };

  const reset = () => {
    setSelectedImage(null);
    setProcessedImage(null);
    setError(null);
  };

  // Paste image from clipboard (Ctrl+V)
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        const dataUrl = await readFileToDataUrl(file);
        setSelectedImage(dataUrl);
        setProcessedImage(null);
        setError(null);
      }
    };
    window.addEventListener('paste', onPaste as any);
    return () => window.removeEventListener('paste', onPaste as any);
  }, []);

  return (
    <div className="page">
      <header className="appbar">
        <div className="brand">
          <span className="logo">✨</span>
          <div className="titles">
            <h1>Background Remover</h1>
            <p className="subtitle">Upload / kéo-thả / dán ảnh để xoá nền nhanh</p>
          </div>
        </div>
        <div className="actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip">ID: {deviceId || '...'}</span>
          <span className="chip">Credits: {credits}</span>
          {!!selectedImage && !processedImage && (
            <button className="btn primary" onClick={removeBackground} disabled={isProcessing}>
              {isProcessing ? '⏳ Đang xử lý…' : '✨ Remove Background'}
            </button>
          )}
          {!!processedImage && (
            <>
              <button className="btn primary" onClick={saveProcessed}>
                💾 Lưu…
              </button>
              <button className="btn" onClick={reset}>
                🔄 Làm lại
              </button>
            </>
          )}
        </div>
      </header>

      <div className="content" ref={scrollRef}>
        {!selectedImage ? (
          <section className="card upload-card">
            <label
              htmlFor="file-input"
              className={`dropzone ${dragOver ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <div className="drop-icon">📸</div>
              <div className="drop-title">Kéo-thả ảnh vào đây</div>
              <div className="drop-sub">hoặc bấm để chọn file – hoặc Ctrl+V để dán ảnh</div>
            </label>
            <input id="file-input" type="file" accept="image/*" onChange={handleImageSelect} className="hidden-input" />
          </section>
        ) : (
          <section className="grid">
            <div className="card">
              <div className="card-head">
                <h3>Ảnh gốc</h3>
                <button className="btn subtle" onClick={reset}>
                  🔄 Đổi ảnh
                </button>
              </div>
              <div className="image-wrap">
                <img src={selectedImage} className="preview" alt="Original" />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Kết quả</h3>
                {isProcessing ? (
                  <span className="chip processing">Đang xử lý…</span>
                ) : processedImage ? (
                  <span className="chip success">Xong</span>
                ) : (
                  <span className="chip">Chưa có</span>
                )}
              </div>
              <div className={`image-wrap ${isProcessing ? 'loading' : ''}`}>
                {isProcessing && (
                  <div className="skeleton">
                    <div className="bar" />
                  </div>
                )}
                {processedImage ? (
                  <img src={processedImage} className="preview" alt="Processed" />
                ) : (
                  <div className="muted">Nhấn “Remove Background” để xử lý</div>
                )}
              </div>
              {processedImage && (
                <div className="row-right">
                  <button className="btn primary" onClick={saveProcessed}>
                    💾 Lưu…
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {error && (
          <div className="toast error">
            <span>❌ {error}</span>
            <button className="btn tiny" onClick={() => setError(null)}>
              Đóng
            </button>
          </div>
        )}

        <footer className="footnote">
          Tip: có thể <b>kéo-thả</b> ảnh, <b>Ctrl+V</b> dán ảnh, hoặc dùng nút chọn file. Khu vực nội dung có{' '}
          <b>cuộn mượt</b> khi ảnh lớn.
        </footer>

        {/* Panel: Batch Background Remover */}
        <BatchRemoverPanel onCredits={setCredits} /> {/* ★ truyền setter xuống */}
      </div>

      {/* Paywall */}
      <Paywall
        open={paywallOpen}
        deviceId={deviceId}
        onClose={() => setPaywallOpen(false)}
        onReload={async () => {
          const c = await window.credits?.sync();
          if (typeof c?.count === 'number') setCredits(c.count);
          setPaywallOpen(false);
        }}
      />
    </div>
  );
}

/** =================================
 *  Component: Batch Background Remover
 *  ================================= */
type BatchItem = {
  filePath: string;
  beforeUrl: string;
  afterUrl?: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
};

// ★ nhận callback cập nhật credits từ parent
type BatchRemoverPanelProps = {
  onCredits?: (n: number) => void;
};

function BatchRemoverPanel({ onCredits }: BatchRemoverPanelProps) {
  const [folder, setFolder] = useState<string | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [outDir, setOutDir] = useState<string | null>(null); // temp dir
  const [lastSavedTo, setLastSavedTo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastDestParent, setLastDestParent] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const offRef = useRef<null | (() => void)>(null);

  // Lắng nghe tiến trình từ main qua preload
  useEffect(() => {
    if (!window.batch) return;
    if (offRef.current) offRef.current();
    offRef.current = window.batch.onProgress(({ filePath, outPath, status, error, done, total }) => {
      setDone(done);
      setTotal(total);
      setItems((prev) => {
        const idx = prev.findIndex((x) => x.filePath === filePath);
        const next: BatchItem = {
          filePath,
          beforeUrl: toFileUrl(filePath),
          afterUrl: outPath ? toFileUrl(outPath) : undefined,
          status,
          error,
        };
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = { ...prev[idx], ...next };
          return copy;
        }
        return [...prev, next];
      });
      if (status === 'skipped' && error === 'NO_CREDIT') {
        setMsg('Bạn đã hết lượt. Vui lòng nạp thêm để tiếp tục xử lý batch.');
      }
    });
    return () => {
      offRef.current?.();
      offRef.current = null;
    };
  }, []);

  const pickFolder = useCallback(async () => {
    const p = await window.batch?.pickFolder();
    if (p) {
      setFolder(p);
      setItems([]);
      setDone(0);
      setTotal(0);
      setOutDir(null);
      setLastSavedTo(null);
      setMsg(null);
    }
  }, []);

  const startBatch = useCallback(async () => {
    if (!window.batch || !folder) return;
    setRunning(true);
    setItems([]);
    setDone(0);
    setTotal(0);
    setOutDir(null);
    setLastSavedTo(null);
    setMsg(null);
    const id = genId();
    const res = await window.batch.start(id, { folder });
    setRunning(false);
    if (res?.success) {
      setOutDir(res.outDir || null);
      if (typeof res.credits === 'number') onCredits?.(res.credits); // ★ cập nhật credits ở parent
    } else if (res?.error) {
      setMsg(`❌ Không thể bắt đầu batch: ${res.error}`);
    }
  }, [folder, onCredits]);

  const resetBatch = useCallback(async () => {
    setFolder(null);
    setItems([]);
    setDone(0);
    setTotal(0);
    setOutDir(null);
    setLastSavedTo(null);
    setRunning(false);
    setLastDestParent(null);
    setMsg(null);

    // (tuỳ chọn) đồng bộ lại credits sau khi reset
    try {
      const info = await (window as any).credits?.sync?.();
      if (typeof info?.count === 'number') onCredits?.(info.count);
    } catch {}
  }, [onCredits]);

  const saveAll = useCallback(async () => {
    if (!window.batch || !outDir) return;

    // Dùng lại parent cũ nếu có; nếu chưa thì mở chọn 1 lần
    let destParent = lastDestParent;
    if (!destParent) {
      destParent = await window.batch.pickDest();
      if (!destParent) return; // user cancel
      setLastDestParent(destParent);
    }

    try {
      // KHÔNG truyền folderName -> main sẽ tự tạo tên mặc định
      const r = await window.batch.saveAll(outDir, destParent, undefined);
      if (r?.success) {
        setLastSavedTo(r.dest); // r.dest = destParent/<auto-folder-name>
        setMsg(`✅ Đã lưu ${r.copied} file vào: ${r.dest}`);
      } else {
        setMsg(`❌ Lưu thất bại: ${r?.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      setMsg(`❌ Lỗi saveAll: ${e?.message || String(e)}`);
    }
  }, [outDir, lastDestParent]);

  const percent = useMemo(() => (total ? Math.round((done / total) * 100) : 0), [done, total]);

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="card-head">
        <h3>Batch Background Remover</h3>
        <span className="chip">
          {done}/{total} ({percent}%)
        </span>
      </div>

      <div className="row gap">
        <button className="btn" onClick={pickFolder}>
          📁 Chọn thư mục nguồn…
        </button>
        <button className="btn primary" onClick={startBatch} disabled={!folder || running}>
          {running ? '⏳ Đang xử lý…' : '🚀 Bắt đầu xử lý'}
        </button>
        <button className="btn" onClick={saveAll} disabled={!outDir || done === 0}>
          💾 Lưu tất cả…
        </button>
         <button className="btn" onClick={resetBatch} disabled={running}>🔄 Làm lại</button>
        {folder && (
          <div className="muted ml-auto">
            Nguồn: <code>{folder}</code>
          </div>
        )}
      </div>

      <div className="muted" style={{ marginTop: 6 }}>
        {outDir ? (
          <>
            Kết quả đang ở tạm: <code>{outDir}</code>
            {lastSavedTo && (
              <>
                {' '}
                — đã lưu tới: <code>{lastSavedTo}</code>
              </>
            )}
          </>
        ) : (
          <>Chưa xử lý</>
        )}
      </div>

      {!!msg && (
        <div className="toast" style={{ marginTop: 8 }}>
          {msg}
        </div>
      )}

      <div className="thumb-grid-wrap" style={{ marginTop: 16 }}>
        {items.length === 0 && <div className="muted">Chưa có mục nào. Hãy chọn thư mục và bấm “Bắt đầu xử lý”.</div>}

        {items.map((it) => (
          <div key={it.filePath} className="thumb">
            <div className="thumb-head" title={it.filePath}>
              {basename(it.filePath)}
            </div>

            <div className="thumb-grid-2">
              <div className="img-box">
                <div className="label">Before</div>
                <img src={it.beforeUrl} alt="before" />
              </div>

              <div className="img-box">
                <div className="label">After</div>
                {it.afterUrl ? <img src={it.afterUrl} alt="after" /> : <div className="placeholder">…</div>}
              </div>
            </div>

            <div className="thumb-foot">
              {it.status === 'ok' && <span className="chip success">ok</span>}
              {it.status === 'skipped' && <span className="chip warn">skipped</span>}
              {it.status === 'error' && <span className="chip error">error</span>}
              {it.error && <span className="muted" style={{ marginLeft: 8 }}>{it.error}</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<BackgroundRemover />} />
      </Routes>
    </Router>
  );
}
