import { z } from 'zod';
import type { Half, TaskStatus } from './models';

// 半天分桶边界
export const boundariesSchema = z.object({
  morningEnd: z.number().int().min(0).max(23),
  afternoonEnd: z.number().int().min(1).max(24),
});

// 快速记录输入校验
export const recordInputSchema = z.object({
  content: z.string().trim().min(1, '内容不能为空'),
  durationMin: z.number().int().positive().nullish(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD'),
  half: z.enum(['allday', 'morning', 'afternoon', 'evening'] as const satisfies readonly Half[]),
  taskId: z.string().nullish(),
  projectId: z.string().nullish(),
});
export type RecordInputParsed = z.infer<typeof recordInputSchema>;

export const taskInputSchema = z.object({
  title: z.string().trim().min(1, '任务名不能为空'),
  projectId: z.string().nullish(),
  status: z.enum(['active', 'paused', 'done'] as const satisfies readonly TaskStatus[]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  note: z.string().optional().default(''),
});
export type TaskInputParsed = z.infer<typeof taskInputSchema>;

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, '项目名不能为空'),
  color: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type ProjectInputParsed = z.infer<typeof projectInputSchema>;
