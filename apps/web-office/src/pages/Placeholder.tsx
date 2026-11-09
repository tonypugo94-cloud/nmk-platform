export function Placeholder({ title }: { title: string }) {
  return (<><h1>{title}</h1><p className="sub">Модуль подключён, но его экран ещё не добавлен в интерфейс. Данные и события модуля уже работают.</p></>);
}
