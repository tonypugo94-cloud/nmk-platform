import { NavLink, Outlet } from "react-router-dom";
import { useMe, hasAny } from "../lib/auth";
import { useMenu } from "../lib/modules";
import { supabase } from "../lib/supabase";
import { SyncBanner } from "./SyncBanner";

export function Layout() {
  const { fullName, roles } = useMe();
  const menu = useMenu();
  return (
    <>
      <header className="header">
        <div className="brand">НМК · Производство</div>
        <nav className="nav" aria-label="Разделы">
          {menu.map((i) => (
            <NavLink key={i.path} to={i.path} title={i.alive ? undefined : "Сервис модуля не отвечает"}>
              {i.title}{i.alive ? "" : " ⚠"}
            </NavLink>
          ))}
          {hasAny(roles, ["admin"]) && <NavLink to="/admin/modules">Модули</NavLink>}
        </nav>
        <div className="who">{fullName}<button onClick={() => supabase.auth.signOut()}>Выйти</button></div>
      </header>
      <SyncBanner />
      <main className="main"><Outlet /></main>
    </>
  );
}
