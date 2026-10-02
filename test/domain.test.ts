import { describe, expect, it } from 'vitest';
import { Decision, DomainError, Objective, Task } from '../src/domain';

describe('Task state machine', () => {
  it('mengizinkan alur normal dan retry', () => {
    expect(Task.can('pending', 'queued')).toBe(true);
    expect(Task.can('queued', 'running')).toBe(true);
    expect(Task.can('running', 'completed')).toBe(true);
    expect(Task.can('running', 'queued')).toBe(true);
  });

  it('menolak transisi ilegal', () => {
    expect(() => Task.assert('pending', 'running')).toThrow(DomainError);
    expect(() => Task.assert('completed', 'queued')).toThrow(DomainError);
    expect(() => Task.assert('failed', 'running')).toThrow(DomainError);
  });

  it('status terminal tidak punya transisi keluar', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) expect(Task.isTerminal(s)).toBe(true);
    expect(Task.isTerminal('running')).toBe(false);
  });
});

describe('Objective & Decision state machine', () => {
  it('objective hanya aktif dari new atau awaiting_approval', () => {
    expect(Objective.can('new', 'active')).toBe(true);
    expect(Objective.can('awaiting_approval', 'active')).toBe(true);
    expect(Objective.can('strategizing', 'active')).toBe(false);
  });

  it('decision yang sudah approved hanya bisa digantikan, tidak diubah', () => {
    expect(Decision.can('approved', 'superseded')).toBe(true);
    expect(Decision.can('approved', 'rejected')).toBe(false);
  });
});
