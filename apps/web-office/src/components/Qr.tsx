import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function Qr({ value, size = 140 }: { value: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(value, { margin: 1, width: size }).then(setSrc); }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt={`QR ${value}`} /> : null;
}
