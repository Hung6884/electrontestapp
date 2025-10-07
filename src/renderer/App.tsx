import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';

function BackgroundRemover() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content appears
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [selectedImage, processedImage, error]);

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

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLLabelElement>) => {
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
    },
    []
  );

  const removeBackground = async () => {
    if (!selectedImage) return;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await window.electron.ipcRenderer.invoke('remove-background', selectedImage);
      if (result?.success) {
        setProcessedImage(result.data); // expect dataURL/base64
      } else {
        setError(result?.error || 'Xử lý thất bại');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Có lỗi xảy ra');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadImage = () => {
    if (!processedImage) return;
    const a = document.createElement('a');
    a.href = processedImage;
    a.download = 'removed-background.png';
    a.click();
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
        <div className="actions">
          {!!selectedImage && !processedImage && (
            <button className="btn primary" onClick={removeBackground} disabled={isProcessing}>
              {isProcessing ? '⏳ Đang xử lý…' : '✨ Remove Background'}
            </button>
          )}
          {!!processedImage && (
            <>
              <button className="btn primary" onClick={downloadImage}>💾 Tải xuống</button>
              <button className="btn" onClick={reset}>🔄 Làm lại</button>
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
            <input
              id="file-input"
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden-input"
            />
          </section>
        ) : (
          <section className="grid">
            <div className="card">
              <div className="card-head">
                <h3>Ảnh gốc</h3>
                <button className="btn subtle" onClick={reset}>🔄 Đổi ảnh</button>
              </div>
              <div className="image-wrap">
                <img src={selectedImage} className="preview" alt="Original" />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Kết quả</h3>
                {isProcessing ? <span className="chip processing">Đang xử lý…</span> : processedImage ? <span className="chip success">Xong</span> : <span className="chip">Chưa có</span>}
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
                  <button className="btn primary" onClick={downloadImage}>💾 Tải xuống</button>
                </div>
              )}
            </div>
          </section>
        )}

        {error && (
          <div className="toast error">
            <span>❌ {error}</span>
            <button className="btn tiny" onClick={() => setError(null)}>Đóng</button>
          </div>
        )}

        <footer className="footnote">
          Tip: có thể **kéo-thả** ảnh, **Ctrl+V** dán ảnh, hoặc dùng nút chọn file. Khu vực nội dung có **cuộn mượt** khi ảnh lớn.
        </footer>
      </div>
    </div>
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
