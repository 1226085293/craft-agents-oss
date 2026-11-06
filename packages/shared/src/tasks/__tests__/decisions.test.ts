import { describe, expect, it } from 'bun:test';

import {
  assessDecisionRequest,
  DECISION_CATEGORIES,
  isRoutineWork,
  routineContinuationNote,
} from '../decisions.ts';

describe('decision gate', () => {
  it('asks before deleting data', () => {
    const verdict = assessDecisionRequest('需要删除生产数据库的历史表');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('destroy-data');
    expect(verdict.label).toBe('删数据');
  });

  it('asks before stopping a service', () => {
    const verdict = assessDecisionRequest('准备重启网关服务');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('stop-service');
  });

  it('asks before spending money', () => {
    const verdict = assessDecisionRequest('想购买一个更高配的实例');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('spend-money');
  });

  it('asks before messaging someone outside', () => {
    const verdict = assessDecisionRequest('把结论发送邮件给客户');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('message-outside');
  });

  it('asks before changing direction', () => {
    const verdict = assessDecisionRequest('建议放弃当前方案，换个方案重做');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('change-direction');
  });

  it('asks before touching credentials', () => {
    const verdict = assessDecisionRequest('想重置生产环境的 API key');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('change-credentials');
  });

  it('does not interrupt routine inspection even when the words overlap', () => {
    // "检查" + "权限" would otherwise look like credentials work.
    const verdict = assessDecisionRequest('巡检一下权限配置有没有过期');
    expect(verdict.needsUser).toBe(false);
    expect(verdict.reason).toContain('日常');
  });

  it('does not interrupt a routine re-review', () => {
    expect(assessDecisionRequest('复核这个 PR 的接口改动').needsUser).toBe(false);
  });

  it('falls back to asking when the text matches nothing', () => {
    // A lexical matcher can prove "routine", never "safe".
    const verdict = assessDecisionRequest('要你定');
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBeUndefined();
    expect(verdict.label).toBe('需要拍板');
  });

  it('treats an empty request as something to ask about', () => {
    expect(assessDecisionRequest('   ').needsUser).toBe(true);
  });

  it('reads commands and paths as extra signal', () => {
    const verdict = assessDecisionRequest('需要你确认', {
      commands: ['rm -rf /data/prod'],
      paths: ['/data/prod'],
    });
    expect(verdict.needsUser).toBe(true);
    expect(verdict.category).toBe('destroy-data');
  });

  it('covers all six categories exactly once', () => {
    expect(DECISION_CATEGORIES).toHaveLength(6);
    expect(new Set(DECISION_CATEGORIES.map((spec) => spec.category)).size).toBe(6);
  });

  it('routine detection is a positive signal, not a default', () => {
    expect(isRoutineWork('巡检磁盘')).toBe(true);
    expect(isRoutineWork('删除生产库')).toBe(false);
  });

  it('explains the outcome back to the worker so it does not ask again', () => {
    const note = routineContinuationNote(assessDecisionRequest('复核接口改动'));
    expect(note).toContain('不需要用户拍板');
    expect(note).toContain('六类');
  });
});
