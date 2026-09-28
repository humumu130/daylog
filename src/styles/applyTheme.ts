/**
 * 主题单一通道（P2 起）：html[data-theme] 属性驱动 --dl- token 明暗切换，
 * 取代 FluentProvider 主题注入。三窗口统一走这里。
 */
export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}
