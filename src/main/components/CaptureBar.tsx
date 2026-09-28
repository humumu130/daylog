import { useMemo, useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { Button } from '../../ui';
import { CaptureInput } from './CaptureInput';
import { useProjectsStore } from '../../stores/useProjectsStore';
import { useRecordsStore } from '../../stores/useRecordsStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useTasksStore } from '../../stores/useTasksStore';
import type { Half } from '../../types/models';
import { formatYMDChinese } from '../../utils/date';
import { formatHours, halfOf } from '../../utils/halfDay';
import { notifyChanged } from '../../services/events';
import { autoDuration, commitAutoDuration } from '../../services/duration';
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
  const dailyCapHours = useSettingsStore((s) => s.settings.dailyCapHours);

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
      if (e.durationMin !== null) {
        await create({
          content: e.content,
          durationMin: e.durationMin,
          day: recordDay,
          half,
          taskId: e.taskId,
          projectId: e.projectId,
          source: 'manual',
        });
      } else {
        // 先规划 → 先建新记录 → 建成功后再压缩已有（保证原子性）
        const plan = await autoDuration(recordDay, dailyCapHours);
        await create({
          content: e.content,
          durationMin: plan.share,
          day: recordDay,
          half,
          taskId: e.taskId,
          projectId: e.projectId,
          source: 'manual',
          meta: { autoDuration: true },
        });
        await commitAutoDuration(plan);
      }
    }
    await notifyChanged();
    setText('');
    setFlashed(true);
    setTimeout(() => setFlashed(false), 900);
  }

  return (
    <div className={`capture-bar${flashed ? ' flashed' : ''}`}>
      <div className="capture-row">
        <CaptureInput
          value={text}
          onChange={setText}
          onSubmit={() => void save()}
          placeholder="修复登录页 2h #用户中心   （支持：昨天 / 5号 / X月X日 / ; 多条）"
          icon={<span className="capture-icon">{flashed ? <Check size={18} /> : <Pencil size={18} />}</span>}
          wrapClassName="capture-input"
        />
        <Button variant="primary" className="capture-btn" onClick={() => void save()}>
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
