import { describe, expect, it } from 'vitest';
import { describeFailure, newErrorRef } from './failure';

class DrizzleQueryError extends Error {
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

describe('describeFailure', () => {
  it('reads the database code from the cause and the class from the constructor', () => {
    const pg = Object.assign(new Error('duplicate key'), { code: '23505' });
    const e = new DrizzleQueryError('Failed query: insert ... params: Ngoc,+18135550100', pg);
    expect(describeFailure('action:x', 'ABC234', e)).toEqual({
      where: 'action:x',
      ref: 'ABC234',
      kind: 'DrizzleQueryError',
      code: '23505',
    });
  });

  it('never carries the message, the stack or the parameters', () => {
    const e = new DrizzleQueryError('Failed query params: Ngoc,+18135550100', {
      code: '08006',
      message: 'connection to +18135550100 lost',
    });
    const line = JSON.stringify(describeFailure('action:x', 'ABC234', e));
    expect(line).not.toContain('Ngoc');
    expect(line).not.toContain('8135550100');
    expect(line).not.toContain('Failed query');
  });

  it('drops a code that is not a short token', () => {
    const e = Object.assign(new Error('x'), { code: 'phone +18135550100 bad' });
    expect(describeFailure('w', 'R', e).code).toBeUndefined();
  });

  it('handles values that are not errors', () => {
    expect(describeFailure('w', 'R', 'boom')).toEqual({ where: 'w', ref: 'R', kind: 'string' });
    expect(describeFailure('w', 'R', null).kind).toBe('object');
  });
});

describe('newErrorRef', () => {
  it('is six readable characters', () => {
    for (let i = 0; i < 50; i++) expect(newErrorRef()).toMatch(/^[A-HJKMNP-TV-Z2-9]{6}$/);
  });
});

describe('isDatabaseError', () => {
  it('knows a failed query and a Postgres error', async () => {
    const { isDatabaseError } = await import('./failure');
    expect(isDatabaseError(new Error('Failed query: select 1\nparams: x'))).toBe(true);
    expect(isDatabaseError(Object.assign(new Error('x'), { code: '23505' }))).toBe(true);
    expect(isDatabaseError(Object.assign(new Error('x'), { cause: { code: '08006' } }))).toBe(true);
    expect(isDatabaseError(new Error('render failed'))).toBe(false);
    expect(isDatabaseError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isDatabaseError('Failed query')).toBe(false);
  });
});
