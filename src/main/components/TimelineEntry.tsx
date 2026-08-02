import { DeleteRegular, EditRegular } from '@fluentui/react-icons';
import type { Project, Task, WorkRecord } from '../../types/models';
import { formatHM } from '../../utils/halfDay';

interface Props {
  record: WorkRecord;
  project?: Project;
  task?: Task;
  onEdit: (r: WorkRecord) => void;
  onDelete: (id: string) => void;
}

export function TimelineEntry({ record, project, onEdit, onDelete }: Props) {
  const d = new Date(record.createdAt);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return (
    <div className="tl-row" onClick={() => onEdit(record)}>
      <span className="tl-time">{time}</span>
      <div className="tl-axis">
        <span className="tl-dot" />
      </div>
      <div className="tl-body">
        <span className="tl-content">{record.content}</span>
        {project && (
          <span
            className="tl-ptag"
            style={{ background: project.color + '1a', color: project.color }}
          >
            {project.name}
          </span>
        )}
        {record.durationMin != null && <span className="tl-dur">{formatHM(record.durationMin)}</span>}
        <span className="tl-actions">
          <button className="icon-btn" title="编辑" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>
            <EditRegular />
          </button>
          <button className="icon-btn" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(record.id); }}>
            <DeleteRegular />
          </button>
        </span>
      </div>
    </div>
  );
}
