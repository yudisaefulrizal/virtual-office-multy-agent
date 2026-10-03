import { stateMachine } from './state-machine';

export { DomainError, UserError } from './state-machine';

// Assignment adalah field, bukan state (lihat docs/DESIGN.md §4.3).
export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export const Task = stateMachine<TaskStatus>('Task', {
  pending: ['queued', 'cancelled'],
  queued: ['running', 'cancelled'],
  // running → queued: retry atau penundaan rate limit.
  running: ['completed', 'queued', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export type ObjectiveStatus =
  | 'new'
  | 'strategizing'
  | 'awaiting_approval'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled';
export const Objective = stateMachine<ObjectiveStatus>('Objective', {
  new: ['strategizing', 'active', 'cancelled'],
  strategizing: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['strategizing', 'active', 'cancelled'],
  active: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export type DecisionStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export const Decision = stateMachine<DecisionStatus>('Decision', {
  proposed: ['approved', 'rejected'],
  approved: ['superseded'],
  rejected: [],
  superseded: [],
});

export type ProjectStatus = 'active' | 'completed' | 'failed' | 'cancelled';
export const Project = stateMachine<ProjectStatus>('Project', {
  active: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export type TaskKind = 'framing' | 'consultation' | 'decision' | 'planning' | 'research' | 'work' | 'review';

/** waiting_provider: runtime-nya belum dikonfigurasi; aktif otomatis saat provider dipasang. */
export type AgentStatus = 'active' | 'inactive' | 'waiting_provider';

/** Siapa yang melakukan sesuatu. Dicatat di setiap event. */
export type Actor = 'owner' | 'orchestrator' | 'scheduler' | `agent:${string}`;
