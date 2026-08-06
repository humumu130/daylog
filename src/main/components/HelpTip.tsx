import { QuestionCircleRegular } from '@fluentui/react-icons';

/** 小问号图标，鼠标悬停显示提示文字（替代冗长的 subtle 描述） */
export function HelpTip({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{ marginLeft: 4, cursor: 'help', color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}
    >
      <QuestionCircleRegular style={{ fontSize: 12 }} />
    </span>
  );
}
