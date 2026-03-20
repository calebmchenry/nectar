import { describe, expect, it } from 'vitest';
import { parseStylesheet, resolveNodeStyle, StylesheetRule } from '../../src/garden/stylesheet.js';
import { GardenNode } from '../../src/garden/types.js';

function makeNode(overrides: Partial<GardenNode> = {}): GardenNode {
  return {
    id: overrides.id ?? 'test_node',
    kind: overrides.kind ?? 'codergen',
    shape: overrides.shape ?? 'box',
    classes: overrides.classes ?? [],
    attributes: overrides.attributes ?? {},
    ...overrides,
  };
}

describe('parseStylesheet', () => {
  it('parses universal selector', () => {
    const { rules, errors } = parseStylesheet('* { llm_model: claude-sonnet-4-20250514 }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector.type).toBe('universal');
    expect(rules[0]!.selector.specificity).toBe(0);
    expect(rules[0]!.properties.llm_model).toBe('claude-sonnet-4-20250514');
  });

  it('parses shape selector', () => {
    const { rules, errors } = parseStylesheet('box { llm_model: claude-sonnet-4-20250514 }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector.type).toBe('shape');
    expect(rules[0]!.selector.value).toBe('box');
    expect(rules[0]!.selector.specificity).toBe(1);
  });

  it('parses class selector', () => {
    const { rules, errors } = parseStylesheet('.drafts { llm_provider: anthropic }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector.type).toBe('class');
    expect(rules[0]!.selector.value).toBe('drafts');
    expect(rules[0]!.selector.specificity).toBe(2);
  });

  it('parses id selector', () => {
    const { rules, errors } = parseStylesheet('#review { reasoning_effort: high }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector.type).toBe('id');
    expect(rules[0]!.selector.value).toBe('review');
    expect(rules[0]!.selector.specificity).toBe(3);
  });

  it('parses multiple rules', () => {
    const { rules, errors } = parseStylesheet(`
      * { llm_model: gpt-4o }
      box { llm_model: claude-sonnet-4-20250514 }
      #deep_review { llm_model: claude-opus-4-20250514; reasoning_effort: high }
    `);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules).toHaveLength(3);
  });

  it('handles multiple properties with semicolons', () => {
    const { rules, errors } = parseStylesheet('box { llm_model: claude-sonnet-4-20250514; llm_provider: anthropic; reasoning_effort: medium }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules[0]!.properties).toEqual({
      llm_model: 'claude-sonnet-4-20250514',
      llm_provider: 'anthropic',
      reasoning_effort: 'medium',
    });
  });

  it('handles trailing semicolon on last declaration', () => {
    const { rules, errors } = parseStylesheet('box { llm_model: claude-sonnet-4-20250514; }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules[0]!.properties.llm_model).toBe('claude-sonnet-4-20250514');
  });

  it('handles quoted values', () => {
    const { rules, errors } = parseStylesheet('box { llm_model: "claude-sonnet-4-20250514" }');
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
    expect(rules[0]!.properties.llm_model).toBe('claude-sonnet-4-20250514');
  });

  it('reports error for missing colon', () => {
    const { errors } = parseStylesheet('box { llm_model claude-sonnet-4-20250514 }');
    expect(errors.some(e => e.code === 'STYLESHEET_SYNTAX' && e.severity === 'error')).toBe(true);
  });

  it('reports error for missing opening brace', () => {
    const { errors } = parseStylesheet('box llm_model: claude-sonnet-4-20250514 }');
    expect(errors.some(e => e.code === 'STYLESHEET_SYNTAX' && e.severity === 'error')).toBe(true);
  });

  it('reports warning for unknown properties', () => {
    const { errors } = parseStylesheet('box { unknown_prop: value }');
    expect(errors.some(e => e.code === 'STYLESHEET_UNKNOWN_PROPERTY' && e.severity === 'warning')).toBe(true);
  });

  it('recovers valid rules after syntax error', () => {
    const { rules, errors } = parseStylesheet(`
      box { llm_model claude-sonnet-4-20250514 }
      #review { reasoning_effort: high }
    `);
    // First rule has syntax error (missing colon)
    expect(errors.some(e => e.severity === 'error')).toBe(true);
    // But second rule still parses
    expect(rules.some(r => r.selector.type === 'id' && r.properties.reasoning_effort === 'high')).toBe(true);
  });

  it('handles empty stylesheet', () => {
    const { rules, errors } = parseStylesheet('');
    expect(rules).toHaveLength(0);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('handles whitespace-only stylesheet', () => {
    const { rules, errors } = parseStylesheet('   \n\n  ');
    expect(rules).toHaveLength(0);
    expect(errors.filter(e => e.severity === 'error')).toHaveLength(0);
  });

  it('preserves source order', () => {
    const { rules } = parseStylesheet(`
      * { llm_model: a }
      box { llm_model: b }
      .cls { llm_model: c }
    `);
    expect(rules[0]!.sourceOrder).toBe(0);
    expect(rules[1]!.sourceOrder).toBe(1);
    expect(rules[2]!.sourceOrder).toBe(2);
  });
});

describe('resolveNodeStyle', () => {
  it('universal selector matches all nodes', () => {
    const { rules } = parseStylesheet('* { llm_model: gpt-4o }');
    const style = resolveNodeStyle(rules, makeNode());
    expect(style.llmModel).toBe('gpt-4o');
  });

  it('shape selector matches by shape', () => {
    const { rules } = parseStylesheet('box { llm_model: claude-sonnet-4-20250514 }');
    const style = resolveNodeStyle(rules, makeNode({ shape: 'box' }));
    expect(style.llmModel).toBe('claude-sonnet-4-20250514');
  });

  it('shape selector does not match wrong shape', () => {
    const { rules } = parseStylesheet('diamond { llm_model: claude-sonnet-4-20250514 }');
    const style = resolveNodeStyle(rules, makeNode({ shape: 'box' }));
    expect(style.llmModel).toBeUndefined();
  });

  it('class selector matches by class', () => {
    const { rules } = parseStylesheet('.drafts { llm_provider: anthropic }');
    const style = resolveNodeStyle(rules, makeNode({ classes: ['drafts'] }));
    expect(style.llmProvider).toBe('anthropic');
  });

  it('class selector does not match without class', () => {
    const { rules } = parseStylesheet('.drafts { llm_provider: anthropic }');
    const style = resolveNodeStyle(rules, makeNode({ classes: [] }));
    expect(style.llmProvider).toBeUndefined();
  });

  it('id selector matches by node id', () => {
    const { rules } = parseStylesheet('#review { reasoning_effort: high }');
    const style = resolveNodeStyle(rules, makeNode({ id: 'review' }));
    expect(style.reasoningEffort).toBe('high');
  });

  it('id selector does not match different id', () => {
    const { rules } = parseStylesheet('#review { reasoning_effort: high }');
    const style = resolveNodeStyle(rules, makeNode({ id: 'implement' }));
    expect(style.reasoningEffort).toBeUndefined();
  });

  it('higher specificity wins over lower', () => {
    const { rules } = parseStylesheet(`
      * { llm_model: default }
      box { llm_model: shape-level }
      .drafts { llm_model: class-level }
      #review { llm_model: id-level }
    `);
    const style = resolveNodeStyle(rules, makeNode({
      id: 'review',
      shape: 'box',
      classes: ['drafts'],
    }));
    expect(style.llmModel).toBe('id-level');
  });

  it('same specificity: last rule wins', () => {
    const { rules } = parseStylesheet(`
      box { llm_model: first }
      box { llm_model: second }
    `);
    const style = resolveNodeStyle(rules, makeNode({ shape: 'box' }));
    expect(style.llmModel).toBe('second');
  });

  it('merges properties from multiple specificity levels', () => {
    const { rules } = parseStylesheet(`
      * { llm_provider: anthropic }
      box { llm_model: claude-sonnet-4-20250514 }
      #review { reasoning_effort: high }
    `);
    const style = resolveNodeStyle(rules, makeNode({
      id: 'review',
      shape: 'box',
    }));
    expect(style.llmProvider).toBe('anthropic');
    expect(style.llmModel).toBe('claude-sonnet-4-20250514');
    expect(style.reasoningEffort).toBe('high');
  });

  it('returns empty for no matching rules', () => {
    const { rules } = parseStylesheet('.special { llm_model: gpt-4o }');
    const style = resolveNodeStyle(rules, makeNode({ classes: [] }));
    expect(style.llmModel).toBeUndefined();
    expect(style.llmProvider).toBeUndefined();
    expect(style.reasoningEffort).toBeUndefined();
  });

  it('shape match is case-insensitive', () => {
    const { rules } = parseStylesheet('Box { llm_model: claude-sonnet-4-20250514 }');
    const style = resolveNodeStyle(rules, makeNode({ shape: 'box' }));
    expect(style.llmModel).toBe('claude-sonnet-4-20250514');
  });
});
