import { Diagnostic, GardenNode } from './types.js';

// --- Types ---

export type SelectorType = 'universal' | 'shape' | 'class' | 'id';

export interface StylesheetSelector {
  type: SelectorType;
  value: string;
  specificity: number;
}

export interface StylesheetRule {
  selector: StylesheetSelector;
  properties: Record<string, string>;
  sourceOffset: number;
  sourceOrder: number;
}

export interface ResolvedStyle {
  llmModel?: string;
  llmProvider?: string;
  reasoningEffort?: string;
}

export interface ParseStylesheetResult {
  rules: StylesheetRule[];
  errors: Diagnostic[];
}

// --- Specificity ---

const SPECIFICITY: Record<SelectorType, number> = {
  universal: 0,
  shape: 1,
  class: 2,
  id: 3,
};

const KNOWN_PROPERTIES = new Set(['llm_model', 'llm_provider', 'reasoning_effort']);

// --- Tokenizer ---

interface Token {
  type: 'selector' | 'lbrace' | 'rbrace' | 'property' | 'colon' | 'semicolon' | 'value' | 'eof';
  value: string;
  offset: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  function skipWhitespace(): void {
    while (i < input.length && /\s/.test(input[i]!)) {
      i++;
    }
  }

  function readUntil(terminators: Set<string>): string {
    let result = '';
    while (i < input.length && !terminators.has(input[i]!)) {
      result += input[i];
      i++;
    }
    return result;
  }

  function readQuotedString(): string {
    const quote = input[i]!;
    i++; // skip opening quote
    let result = '';
    let escaped = false;
    while (i < input.length) {
      const ch = input[i]!;
      if (escaped) {
        result += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        i++; // skip closing quote
        return result;
      } else {
        result += ch;
      }
      i++;
    }
    return result; // unterminated quote
  }

  while (i < input.length) {
    skipWhitespace();
    if (i >= input.length) break;

    const ch = input[i]!;
    const offset = i;

    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', offset });
      i++;
      continue;
    }

    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', offset });
      i++;
      continue;
    }

    if (ch === ':') {
      tokens.push({ type: 'colon', value: ':', offset });
      i++;
      continue;
    }

    if (ch === ';') {
      tokens.push({ type: 'semicolon', value: ';', offset });
      i++;
      continue;
    }

    // Read a value or identifier
    if (ch === '"' || ch === "'") {
      const str = readQuotedString();
      tokens.push({ type: 'value', value: str, offset });
      continue;
    }

    // Read identifier/selector/value up to special chars
    const raw = readUntil(new Set(['{', '}', ':', ';', ' ', '\t', '\n', '\r', '"', "'"]));
    if (raw.length > 0) {
      tokens.push({ type: 'value', value: raw, offset });
    }
  }

  tokens.push({ type: 'eof', value: '', offset: i });
  return tokens;
}

// --- Parser ---

function parseSelector(token: Token): StylesheetSelector | null {
  const val = token.value.trim();
  if (!val) return null;

  if (val === '*') {
    return { type: 'universal', value: '*', specificity: SPECIFICITY.universal };
  }

  if (val.startsWith('#')) {
    const id = val.slice(1);
    if (!id) return null;
    return { type: 'id', value: id, specificity: SPECIFICITY.id };
  }

  if (val.startsWith('.')) {
    const cls = val.slice(1);
    if (!cls) return null;
    return { type: 'class', value: cls, specificity: SPECIFICITY.class };
  }

  // Otherwise it's a shape selector
  return { type: 'shape', value: val, specificity: SPECIFICITY.shape };
}

export function parseStylesheet(raw: string, file?: string): ParseStylesheetResult {
  const rules: StylesheetRule[] = [];
  const errors: Diagnostic[] = [];
  const tokens = tokenize(raw);
  let pos = 0;
  let ruleOrder = 0;

  function current(): Token {
    return tokens[pos] ?? { type: 'eof', value: '', offset: raw.length };
  }

  function advance(): Token {
    const tok = current();
    pos++;
    return tok;
  }

  function expect(type: Token['type']): Token | null {
    if (current().type === type) {
      return advance();
    }
    return null;
  }

  while (current().type !== 'eof') {
    // Expect a selector
    const selectorToken = current();
    if (selectorToken.type !== 'value') {
      errors.push({
        severity: 'error',
        code: 'STYLESHEET_SYNTAX',
        message: `Unexpected token '${selectorToken.value}' at offset ${selectorToken.offset} — expected a selector`,
        file,
      });
      advance();
      // Try to recover: skip to next '}'
      while (current().type !== 'rbrace' && current().type !== 'eof') {
        advance();
      }
      if (current().type === 'rbrace') advance();
      continue;
    }

    const selector = parseSelector(selectorToken);
    advance();

    if (!selector) {
      errors.push({
        severity: 'error',
        code: 'STYLESHEET_SYNTAX',
        message: `Invalid selector '${selectorToken.value}' at offset ${selectorToken.offset}`,
        file,
      });
      // Skip to next '}'
      while (current().type !== 'rbrace' && current().type !== 'eof') {
        advance();
      }
      if (current().type === 'rbrace') advance();
      continue;
    }

    // Expect '{'
    if (!expect('lbrace')) {
      errors.push({
        severity: 'error',
        code: 'STYLESHEET_SYNTAX',
        message: `Expected '{' after selector '${selectorToken.value}' at offset ${current().offset}`,
        file,
      });
      // Try to recover
      while (current().type !== 'rbrace' && current().type !== 'eof') {
        advance();
      }
      if (current().type === 'rbrace') advance();
      continue;
    }

    // Parse properties until '}'
    const properties: Record<string, string> = {};
    let hasError = false;

    while (current().type !== 'rbrace' && current().type !== 'eof') {
      const propToken = current();
      if (propToken.type !== 'value') {
        // Skip semicolons between properties
        if (propToken.type === 'semicolon') {
          advance();
          continue;
        }
        errors.push({
          severity: 'error',
          code: 'STYLESHEET_SYNTAX',
          message: `Unexpected token '${propToken.value}' — expected property name at offset ${propToken.offset}`,
          file,
        });
        hasError = true;
        advance();
        continue;
      }
      advance();

      // Expect ':'
      if (!expect('colon')) {
        errors.push({
          severity: 'error',
          code: 'STYLESHEET_SYNTAX',
          message: `Missing ':' after property name '${propToken.value}' at offset ${current().offset}`,
          file,
        });
        hasError = true;
        // Skip to next ';' or '}'
        while (current().type !== 'semicolon' && current().type !== 'rbrace' && current().type !== 'eof') {
          advance();
        }
        if (current().type === 'semicolon') advance();
        continue;
      }

      // Expect value
      const valueToken = current();
      if (valueToken.type !== 'value') {
        errors.push({
          severity: 'error',
          code: 'STYLESHEET_SYNTAX',
          message: `Missing value for property '${propToken.value}' at offset ${valueToken.offset}`,
          file,
        });
        hasError = true;
        if (current().type === 'semicolon') advance();
        continue;
      }
      advance();

      // Warn on unknown properties
      if (!KNOWN_PROPERTIES.has(propToken.value)) {
        errors.push({
          severity: 'warning',
          code: 'STYLESHEET_UNKNOWN_PROPERTY',
          message: `Unknown stylesheet property '${propToken.value}' at offset ${propToken.offset}`,
          file,
        });
      }

      properties[propToken.value] = valueToken.value;

      // Consume optional ';'
      if (current().type === 'semicolon') {
        advance();
      }
    }

    // Expect '}'
    if (!expect('rbrace')) {
      errors.push({
        severity: 'error',
        code: 'STYLESHEET_SYNTAX',
        message: `Missing '}' for rule starting at offset ${selectorToken.offset}`,
        file,
      });
    }

    // Even if there were property-level errors, include the rule with whatever valid properties we got
    if (Object.keys(properties).length > 0 || !hasError) {
      rules.push({
        selector,
        properties,
        sourceOffset: selectorToken.offset,
        sourceOrder: ruleOrder++,
      });
    }
  }

  return { rules, errors };
}

// --- Resolver ---

function selectorMatches(selector: StylesheetSelector, node: GardenNode): boolean {
  switch (selector.type) {
    case 'universal':
      return true;
    case 'shape':
      return (node.shape?.toLowerCase() ?? '') === selector.value.toLowerCase();
    case 'class':
      return node.classes.includes(selector.value);
    case 'id':
      return node.id === selector.value;
  }
}

export function resolveNodeStyle(rules: StylesheetRule[], node: GardenNode): ResolvedStyle {
  // Collect matching rules
  const matching = rules.filter((rule) => selectorMatches(rule.selector, node));

  // Sort by specificity ASC, then source order ASC
  matching.sort((a, b) => {
    if (a.selector.specificity !== b.selector.specificity) {
      return a.selector.specificity - b.selector.specificity;
    }
    return a.sourceOrder - b.sourceOrder;
  });

  // Merge: later/higher-specificity wins
  const result: ResolvedStyle = {};
  for (const rule of matching) {
    if (rule.properties.llm_model !== undefined) {
      result.llmModel = rule.properties.llm_model;
    }
    if (rule.properties.llm_provider !== undefined) {
      result.llmProvider = rule.properties.llm_provider;
    }
    if (rule.properties.reasoning_effort !== undefined) {
      result.reasoningEffort = rule.properties.reasoning_effort;
    }
  }

  return result;
}
