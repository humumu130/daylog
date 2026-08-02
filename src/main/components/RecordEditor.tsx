import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Textarea,
} from '@fluentui/react-components';
import type { Half, Project, Task, WorkRecord } from '../../types/models';
import type { RecordInput } from '../../services/db';
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
    const parsed = hours.trim() ? parseFloat(hours) : NaN;
    const durationMin = !isNaN(parsed) ? Math.round(parsed * 60) : null;
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
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{record ? '编辑记录' : '新建记录'}</DialogTitle>
          <DialogContent className="ed-content">
            <Field label="内容">
              <Textarea
                value={content}
                onChange={(_, d) => setContent(d.value)}
                textarea={{ className: 'ed-textarea' }}
              />
            </Field>
            <div className="ed-row">
              <Field label="日期">
                <Input type="date" value={recordDay} onChange={(_, d) => setRecordDay(d.value)} />
              </Field>
              <Field label="半天">
                <Select value={recordHalf} onChange={(v) => setRecordHalf(v as Half)} options={HALF_VALUES.map((h) => ({ value: h, label: HALF_LABEL_CN[h] }))} />
              </Field>
              <Field label="耗时(h)">
                <Input value={hours} onChange={(_, d) => setHours(d.value)} type="number" />
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
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              取消
            </Button>
            <Button appearance="primary" onClick={() => void save()}>
              保存
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
