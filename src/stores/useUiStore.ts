import { create } from 'zustand';

/** 全局 UI 状态：搜索面板开关、外部跳转日期（搜索结果点击后带到今日页） */
interface UiState {
  searchOpen: boolean;
  /** 搜索点击记录后，请求今日页跳到该日期；今日页消费后置空 */
  gotoDay: string | null;
  openSearch: () => void;
  closeSearch: () => void;
  requestGotoDay: (day: string) => void;
  consumeGotoDay: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  searchOpen: false,
  gotoDay: null,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  requestGotoDay: (day) => set({ gotoDay: day, searchOpen: false }),
  consumeGotoDay: () => set({ gotoDay: null }),
}));
