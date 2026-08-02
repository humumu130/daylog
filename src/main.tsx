import ReactDOM from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { QuickCaptureApp } from './capture/QuickCaptureApp';
import { MainApp } from './main/MainApp';
import { WidgetApp } from './widget/WidgetApp';
import './styles/global.css';

const label = getCurrentWebviewWindow().label;
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

if (label === 'quick-capture') {
  root.render(<QuickCaptureApp />);
} else if (label === 'widget') {
  root.render(<WidgetApp />);
} else {
  root.render(<MainApp />);
}
