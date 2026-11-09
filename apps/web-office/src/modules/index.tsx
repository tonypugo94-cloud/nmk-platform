/**
 * Экраны модулей. Ключ — key модуля из core.app_modules.
 * Новый модуль: добавить сюда его маршруты. Если модуль включён, а экрана ещё нет,
 * пункт меню откроет заглушку — интерфейс не ломается.
 */
import type { ReactElement } from "react";
import { OrdersPage, OrderCardPage } from "./orders";
import { LabelsPage, StationPage, WorkloadPage, WarehousePage, LoadingPage } from "./production";
import { PlanningPage, WaybillPage, MessagingPage, ProcurementPage, CrewPage, PieceworkPage, OwnerPage } from "./office";

export const moduleRoutes: Record<string, { path: string; element: ReactElement }[]> = {
  orders: [{ path: "/orders", element: <OrdersPage /> }, { path: "/orders/:id", element: <OrderCardPage /> }],
  tracking: [{ path: "/tracking/labels", element: <LabelsPage /> }, { path: "/station", element: <StationPage /> }],
  workload: [{ path: "/workload", element: <WorkloadPage /> }],
  warehouse: [{ path: "/warehouse", element: <WarehousePage /> }, { path: "/warehouse/loading", element: <LoadingPage /> }],
  procurement: [{ path: "/procurement", element: <ProcurementPage /> }],
  planning: [{ path: "/planning", element: <PlanningPage /> }, { path: "/planning/waybill/:slotId", element: <WaybillPage /> }],
  messaging: [{ path: "/messaging", element: <MessagingPage /> }],
  crew: [{ path: "/crew", element: <CrewPage /> }],
  piecework: [{ path: "/piecework", element: <PieceworkPage /> }],
  analytics: [{ path: "/owner", element: <OwnerPage /> }],
};
