import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 自定义标题，默认"出错了" */
  title?: string;
}
interface State {
  error: Error | null;
}

/**
 * 全局错误边界：捕获子树渲染异常，显示友好提示而非白屏。
 * 用于主窗口 / 快速记录 / 待办浮窗三个根。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 仅控制台留痕，便于排查；不外发
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private reload = () => {
    this.setState({ error: null });
    location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // 自包含内联样式：即便全局 CSS 未加载也能正常显示
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1f1f1f',
          color: '#eee',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>😵‍💫</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>{this.props.title ?? '出错了'}</h2>
          <p style={{ margin: '0 0 6px', fontSize: 13, color: '#bbb', lineHeight: 1.6 }}>
            页面渲染遇到问题。你的数据是安全的，通常刷新即可恢复。
          </p>
          <details style={{ margin: '14px 0', textAlign: 'left', fontSize: 11, color: '#888' }}>
            <summary style={{ cursor: 'pointer' }}>技术细节</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8 }}>
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
            </pre>
          </details>
          <button
            onClick={this.reload}
            style={{
              marginTop: 4,
              padding: '8px 22px',
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              borderRadius: 6,
              background: '#2563eb',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
