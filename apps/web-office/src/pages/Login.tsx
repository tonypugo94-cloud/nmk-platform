import { useState } from "react";
import { supabase } from "../lib/supabase";

export function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  return (
    <form className="login card" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false); if (error) setError("Неверный логин или пароль");
    }}>
      <h1>НМК · Производство</h1>
      <label>Почта<br /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: "100%" }} /></label>
      <label>Пароль<br /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: "100%" }} /></label>
      {error && <div className="err">{error}</div>}
      <button className="primary" disabled={busy}>Войти</button>
    </form>
  );
}
