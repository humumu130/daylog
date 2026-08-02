import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';

// 把 Fluent 组件（主按钮、复选框、输入聚焦环等）的品牌色统一到设计稿 #2563EB
const brand = {
  colorBrandBackground: '#2563eb',
  colorBrandBackgroundHover: '#1d4ed8',
  colorBrandBackgroundPressed: '#1e40af',
  colorBrandBackgroundSelected: '#2563eb',
  colorBrandForeground1: '#2563eb',
  colorBrandForeground2: '#3b82f6',
  colorBrandForegroundLink: '#2563eb',
  colorBrandStroke1: '#2563eb',
  colorBrandBackground2: '#eff6ff',
};

export const lightTheme: Theme = { ...webLightTheme, ...brand };
export const darkTheme: Theme = { ...webDarkTheme, ...brand };
