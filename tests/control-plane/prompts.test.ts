// tests/control-plane/prompts.test.ts
import { describe, expect, it } from 'vitest';

import { renderTemplate, renderExecutePrompt } from '../../src/control-plane/prompts.js';

describe('renderTemplate', () => {
  it('substitutes every {{KEY}} occurrence and leaves unknown braces intact', () => {
    const out = renderTemplate('Hi {{NAME}}, ticket {{TICKET}} / {{NAME}}', {
      NAME: 'PIN agent',
      TICKET: 'PIN-1',
    });
    expect(out).toBe('Hi PIN agent, ticket PIN-1 / PIN agent');
  });

  it('throws when a placeholder has no value (no silent blanks in a bypass agent prompt)', () => {
    expect(() => renderTemplate('a {{MISSING}} b', { OTHER: 'x' })).toThrow(/MISSING/);
  });

  it('treats the value as literal text (a $ or {{...}} inside a value is not re-expanded)', () => {
    const out = renderTemplate('plan: {{PLAN}}', { PLAN: 'use {{TICKET}} and $HOME literally' });
    expect(out).toBe('plan: use {{TICKET}} and $HOME literally');
  });
});

describe('renderExecutePrompt', () => {
  const HARD = '# Hard rules\n1. NEVER push.\n';
  const tpl = `${HARD}\n# APPROVED PLAN\n{{PLAN_BODY}}\n`;

  it('inserts a clearly-delimited, untrusted OPERATOR ANSWERS block AFTER the hard rules', () => {
    const out = renderExecutePrompt(tpl, {
      values: { PLAN_BODY: 'do the thing' },
      operatorAnswers: 'Q1: yes\nQ2: skip the modal',
    });
    expect(out).toContain('do the thing');
    const idxHard = out.indexOf('# Hard rules');
    const idxAnswers = out.indexOf('OPERATOR ANSWERS');
    const idxPlan = out.indexOf('# APPROVED PLAN');
    expect(idxHard).toBeGreaterThanOrEqual(0);
    expect(idxAnswers).toBeGreaterThan(idxHard); // after hard rules
    expect(idxAnswers).toBeLessThan(idxPlan); // before the plan body
    expect(out).toContain('untrusted operator input');
    expect(out).toContain('Q2: skip the modal');
  });

  it('omits the answers block entirely when there are no operator answers', () => {
    const out = renderExecutePrompt(tpl, { values: { PLAN_BODY: 'x' }, operatorAnswers: '' });
    expect(out).not.toContain('OPERATOR ANSWERS');
    expect(out).toContain('x');
  });
});
