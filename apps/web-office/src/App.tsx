import { Navigate, Route, Routes } from "react-router-dom";
import { useMe, hasAny } from "./lib/auth";
import { useMenu } from "./lib/modules";
import { moduleRoutes } from "./modules";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { ModulesAdmin } from "./pages/ModulesAdmin";
import { Placeholder } from "./pages/Placeholder";

export function App() {
  const { session, loading, roles } = useMe();
  const menu = useMenu();
  if (loading) return null;
  if (!session) return <Login />;
  const enabledKeys = new Set(menu.map((m) => m.module));
  const known = new Set(Object.values(moduleRoutes).flat().map((r) => r.path));
  return (
    <Routes>
      <Route element={<Layout />}>
        {Object.entries(moduleRoutes).filter(([k]) => enabledKeys.has(k)).flatMap(([k, rs]) => rs.map((r) => <Route key={k + r.path} path={r.path} element={r.element} />))}
        {menu.filter((m) => !known.has(m.path)).map((m) => <Route key={m.path} path={m.path} element={<Placeholder title={m.title} />} />)}
        {hasAny(roles, ["admin"]) && <Route path="/admin/modules" element={<ModulesAdmin />} />}
        <Route path="*" element={<Navigate to={menu[0]?.path ?? (hasAny(roles, ["admin"]) ? "/admin/modules" : "/")} replace />} />
      </Route>
    </Routes>
  );
}
