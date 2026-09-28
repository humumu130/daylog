import { useEffect, useState } from 'react';
import { Button, Dialog, Field, Input, Textarea } from '../../ui';
import type { Half, Project, Task, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
import { quantizeMinutes } from '../../services/duration';
import { HALF_LABEL_CN, HALF_VALUES } from '../../utils/halfDay';
import { Select } from './Select';

interface Props {
  open: boolean;
  onClose: () => void;
  day: string;
  half: Half;
  record?: WorkRecord | null;
  projects: Project[];
  tasks: Task[];
  onSubmit: (input: RecordInput, existing?: WorkRecord) => Promise<void>;
}

export function RecordEditor({ open, onClose, day, half, record, projects, tasks, onSubmit }: Props) {
  const [content, setContent] = useState('');
  const [recordDay, setRecordDay] = useState(day);
  const [recordHalf, setRecordHalf] = useState<Half>(half);
  const [hours, setHours] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setContent(record?.content ?? '');
    setRecordDay(record?.day ?? day);
    setRecordHalf(record?.half ?? half);
    setHours(record?.durationMin != null ? String(record.durationMin / 60) : '');
    setProjectId(record?.projectId ?? null);
    setTaskId(record?.taskId ?? null);
  }, [open, record, day, half]);

  async function save() {
    const text = content.trim();
    if (!text) return;
    // 0.5h 粒度量化（全链路统一）；空/0/非法 = 无时长
    const parsed = hours.trim() ? parseFloat(hours) : NaN;
    const durationMin = !isNaN(parsed) && parsed > 0 ? quantizeMinutes(parsed * 60) : null;
    await onSubmit(
      {
        content: text,
        durationMin,
        day: recordDay,
        half: recordHalf,
        projectId,
        taskId,
        source: record?.source ?? 'manual',
      },
      record ?? undefined,
    );
    onClose();
  }

  const selectableTasks = tasks.filter((t) => t.status === 'active' || t.id === record?.taskId);

  return (
    <Dialog open={open} onClose={onClose} title={record ? '编辑记录' : '新建记录'} width={520}>
      <div className="ed-content">
        <Field label="内容">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="ed-textarea"
          />
        </Field>
        <div className="ed-row">
          <Field label="日期">
            <Input type="date" value={recordDay} onChange={(e) => setRecordDay(e.target.value)} />
          </Field>
          <Field label="半天">
            <Select value={recordHalf} onChange={(v) => setRecordHalf(v as Half)} options={HALF_VALUES.map((h) => ({ value: h, label: HALF_LABEL_CN[h] }))} />
          </Field>
          <Field label="耗时(h)">
            <Input value={hours} onChange={(e) => setHours(e.target.value)} type="number" />
          </Field>
        </div>
        <div className="ed-row">
          <Field label="项目">
            <Select value={projectId ?? ''} onChange={(v) => setProjectId(v || null)} options={[{ value: '', label: '无' }, ...projects.filter((p) => p.isActive).map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
          <Field label="任务">
            <Select value={taskId ?? ''} onChange={(v) => setTaskId(v || null)} options={[{ value: '', label: '无' }, ...selectableTasks.map((t) => ({ value: t.id, label: t.title }))]} />
          </Field>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <Button variant="default" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}
