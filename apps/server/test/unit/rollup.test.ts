import { describe, expect, it } from 'vitest';
import { lifecycleFromPhases, phaseStatusFromTasks } from '../../src/domain/rollup.js';

/**
 * The rollup rules, without a database (FRM-REQ-183, FRM-REQ-184). `null` is "leave it alone".
 * The integration test covers the gate, the audit events and undo; these pin the table itself.
 */

describe('phase status from its tasks', () => {
  it('starts a phase once any task has been touched', () => {
    expect(phaseStatusFromTasks('planned', ['todo', 'in_progress'])).toBe('active');
    expect(phaseStatusFromTasks('planned', ['todo', 'blocked'])).toBe('active');
    expect(phaseStatusFromTasks('planned', ['todo', 'done'])).toBe('active');
  });

  it('does not count a cancelled task as a start', () => {
    expect(phaseStatusFromTasks('planned', ['todo', 'cancelled'])).toBeNull();
  });

  it('offers complete once everything is done or cancelled', () => {
    expect(phaseStatusFromTasks('active', ['done', 'cancelled'])).toBe('complete');
    expect(phaseStatusFromTasks('planned', ['done'])).toBe('complete');
  });

  it('cancels a phase whose every task was cancelled', () => {
    expect(phaseStatusFromTasks('planned', ['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('reopens a closed phase when work comes back', () => {
    expect(phaseStatusFromTasks('complete', ['done', 'in_progress'])).toBe('active');
    expect(phaseStatusFromTasks('complete', ['done', 'todo'])).toBe('active');
    expect(phaseStatusFromTasks('cancelled', ['todo'])).toBe('planned');
  });

  it('leaves a hand-started phase active before any task moves', () => {
    expect(phaseStatusFromTasks('active', ['todo', 'todo'])).toBeNull();
  });

  it('never touches a parked phase, and says nothing about an empty one', () => {
    expect(phaseStatusFromTasks('parked', ['done', 'done'])).toBeNull();
    expect(phaseStatusFromTasks('parked', ['in_progress'])).toBeNull();
    expect(phaseStatusFromTasks('complete', [])).toBeNull();
  });
});

describe('project lifecycle from its phases', () => {
  it('is building once a phase has started or finished', () => {
    expect(lifecycleFromPhases('planned', ['active', 'planned'])).toBe('building');
    expect(lifecycleFromPhases('scaffolded', ['complete', 'planned'])).toBe('building');
  });

  it('is deployed once every phase is closed and at least one delivered', () => {
    expect(lifecycleFromPhases('building', ['complete', 'cancelled'])).toBe('deployed');
    expect(lifecycleFromPhases('planned', ['complete'])).toBe('deployed');
    expect(lifecycleFromPhases('building', ['cancelled', 'cancelled'])).toBeNull();
  });

  it('promotes only: new planned work does not undeploy a project', () => {
    expect(lifecycleFromPhases('deployed', ['complete', 'planned'])).toBeNull();
    expect(lifecycleFromPhases('building', ['planned'])).toBeNull();
  });

  it('never touches a parked or scrapped project', () => {
    expect(lifecycleFromPhases('parked', ['complete'])).toBeNull();
    expect(lifecycleFromPhases('scrapped', ['active'])).toBeNull();
  });

  it('holds a parked phase open: the project is not finished while one waits', () => {
    expect(lifecycleFromPhases('building', ['complete', 'parked'])).toBeNull();
  });
});
