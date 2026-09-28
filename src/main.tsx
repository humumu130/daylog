import ReactDOM from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { QuickCaptureApp } from './capture/QuickCaptureApp';
import { MainApp } from './main/MainApp';
import { WidgetApp } from './widget/WidgetApp';
import { ErrorBoundary } from './ErrorBoundary';
import './styles/tokens.css'; // --dl- 设计 token
import './styles/base.css'; // reset/滚动条/焦点环（P2 起接管基础层）

const label = getCurrentWebviewWindow().label;
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

if (label === 'quick-capture') {
  root.render(<ErrorBoundary title="快速记录出错了"><QuickCaptureApp /></ErrorBoundary>);
} else if (label === 'widget') {
  root.render(<ErrorBoundary title="待办出错了"><WidgetApp /></ErrorBoundary>);
} else {
  root.render(<ErrorBoundary><MainApp /></ErrorBoundary>);
}
