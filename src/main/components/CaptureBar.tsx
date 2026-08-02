import { useMemo, useState } from 'react';
import { Button, Input } from '@fluentui/react-components';
import { CheckmarkRegular, EditRegular } from '@fluentui/react-icons';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import type { Half } from '../../types/models';
import { formatYMDChinese } from '../../utils/date';
import { formatHours, halfOf } from '../../utils/halfDay';
import { notifyChanged } from '../../services/events';
import { autoDuration } from '../../services/duration';
import { parseEntries } from '../../utils/parseEntry';

interface Props {
  day: string;
  onDayChange: (day: string) => void;
}

export function CaptureBar({ day, onDayChange }: Props) {
  const projects = useProjectsStore((s) => s.projects);
  const tasks = useTasksStore((s) => s.tasks);
  const create = useRecordsStore((s) => s.create);
  const boundaries = useSettingsStore((s) => s.settings.boundaries);

  const [text, setText] = useState('');
  const [flashed, setFlashed] = useState(false);

  const activeTasks = tasks.filter((t) => t.status === 'active');
  const parsed = useMemo(
    () => parseEntries(text, { projects, tasks: activeTasks }),
    [text, projects, activeTasks],
  );
  const validCount = parsed.filter((p) => p.content).length;
  const first = parsed.find((p) => p.content);

  const projName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined);
  const taskTitle = (id: string | null) => (id ? tasks.find((t) => t.id === id)?.title : undefined);

  async function save() {
    const entries = parseEntries(text, { projects, tasks: activeTasks }).filter((p) => p.content);
    if (entries.length === 0) return;
    const half: Half = halfOf(new Date(), boundaries);
    for (const e of entries) {
      const recordDay = e.day || day;
      let durationMin = e.durationMin;
      let meta: Record<string, unknown> | undefined;
      if (durationMin === null) {
        durationMin = await autoDuration(recordDay);
        meta = { autoDuration: true };
      }
      await create({
        content: e.content,
        durationMin,
        day: recordDay,
        half,
        taskId: e.taskId,
        projectId: e.projectId,
        source: 'manual',
        meta,
      });
    }
    await notifyChanged();
    setText('');
    setFlashed(true);
    setTimeout(() => setFlashed(false), 900);
  }

  return (
    <div className={`capture-bar${flashed ? ' flashed' : ''}`}>
      <div className="capture-row">
        <Input
          value={text}
          onChange={(_, d) => setText(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="修复登录页 2h #用户中心   （支持：昨天 / 5号 / X月X日）"
          size="large"
          className="capture-input"
          contentBefore={<span className="capture-icon">{flashed ? <CheckmarkRegular /> : <EditRegular />}</span>}
        />
        <Button appearance="primary" className="capture-btn" onClick={() => void save()}>
          记录
        </Button>
      </div>
      <div className="capture-chips">
        <input type="date" className="sel capture-date" value={day} onChange={(e) => onDayChange(e.target.value)} style={{ width: 'auto' }} title="记录日期" />
        {first?.day && first.day !== day && (
          <span className="chip day-chip" title="输入中检测到的日期" onClick={() => onDayChange(first.day!)}>
            → {formatYMDChinese(first.day)}
          </span>
        )}
        {first?.durationMin != null && <span className="chip">{formatHours(first.durationMin)}</span>}
        {first?.durationMin == null && validCount > 0 && <span className="chip muted-chip">自动分配工时</span>}
        {first?.projectId && <span className="chip">{projName(first.projectId)}</span>}
        {first?.taskId && <span className="chip task-chip">[{taskTitle(first.taskId)}]</span>}
        {validCount > 1 && <span className="chip count-chip">{validCount} 条</span>}
      </div>
    </div>
  );
}
