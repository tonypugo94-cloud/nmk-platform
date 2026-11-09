/**
 * Экраны модулей. Ключ — key модуля из core.app_modules.
 * Новый модуль: добавить сюда его маршруты. Если модуль включён, а экрана ещё нет,
 * пункт меню откроет заглушку — интерфейс не ломается.
 */
import type { ReactElement } from "react";
import { OrdersPage, OrderCardPage } from "./orders";

export const moduleRoutes: Record<string, { path: string; element: ReactElement }[]> = {
  orders: [
    { path: "/orders", element: <OrdersPage /> },
    { path: "/orders/:id", element: <OrderCardPage /> },
  ],
};
