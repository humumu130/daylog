import ReactDOM from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { QuickCaptureApp } from './capture/QuickCaptureApp';
import { MainApp } from './main/MainApp';
import { WidgetApp } from './widget/WidgetApp';
import { ErrorBoundary } from './ErrorBoundary';
import './styles/global.css';

const label = getCurrentWebviewWindow().label;
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

if (label === 'quick-capture') {
  root.render(<ErrorBoundary title="快速记录出错了"><QuickCaptureApp /></ErrorBoundary>);
} else if (label === 'widget') {
  root.render(<ErrorBoundary title="待办出错了"><WidgetApp /></ErrorBoundary>);
} else {
  root.render(<ErrorBoundary><MainApp /></ErrorBoundary>);
}
