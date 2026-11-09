import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";
import "./styles.css";

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  document.getElementById("root")!.innerHTML =
    '<div style="padding:24px;font-family:sans-serif">Не настроено подключение: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (см. .env.example).</div>';
  throw new Error("Supabase env is not configured");
}

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 2 } } });
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}><AuthProvider><BrowserRouter><App /></BrowserRouter></AuthProvider></QueryClientProvider>
  </React.StrictMode>,
);
