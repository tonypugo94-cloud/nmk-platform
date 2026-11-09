/**
 * Сканер QR: камера телефона (BarcodeDetector на Android/Chrome, ZXing как запасной вариант для iPhone)
 * и поле ввода — в него же «печатает» Bluetooth-сканер.
 */
import { useEffect, useRef, useState } from "react";

export function Scanner({ onCode, label = "Отсканируйте QR" }: { onCode: (code: string) => void; label?: string }) {
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const last = useRef({ code: "", at: 0 });

  const emit = (raw: string) => {
    const code = raw.trim().split("/").pop()!.toUpperCase();
    const now = Date.now();
    if (!code || (code === last.current.code && now - last.current.at < 3000)) return;
    last.current = { code, at: now };
    navigator.vibrate?.(80);
    onCode(code);
  };

  useEffect(() => {
    if (!camera) return;
    let stop = () => {};
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        video.current!.srcObject = stream; await video.current!.play();
        const BD = (window as any).BarcodeDetector;
        if (BD) {
          const det = new BD({ formats: ["qr_code"] });
          const t = setInterval(async () => { const r = await det.detect(video.current!).catch(() => []); if (r[0]) emit(r[0].rawValue); }, 300);
          stop = () => { clearInterval(t); stream.getTracks().forEach((x) => x.stop()); };
        } else {
          const { BrowserQRCodeReader } = await import("@zxing/browser");
          const ctl = await new BrowserQRCodeReader().decodeFromVideoElement(video.current!, (res) => res && emit(res.getText()));
          stop = () => { ctl.stop(); stream.getTracks().forEach((x) => x.stop()); };
        }
      } catch (e) { setErr("Камера недоступна: " + (e as Error).message); setCamera(false); }
    })();
    return () => { cancelled = true; stop(); };
  }, [camera]);

  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div className="row">
        <button className="primary" onClick={() => setCamera((c) => !c)}>{camera ? "Выключить камеру" : "Камера"}</button>
        <form className="row" onSubmit={(e) => { e.preventDefault(); emit(manual); setManual(""); }}>
          <input autoFocus placeholder={label} value={manual} onChange={(e) => setManual(e.target.value)} />
          <button>OK</button>
        </form>
      </div>
      {camera && <video ref={video} playsInline muted style={{ width: "100%", maxWidth: 420, borderRadius: 10 }} />}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
