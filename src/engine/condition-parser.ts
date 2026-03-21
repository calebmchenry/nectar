export type BinaryOp =
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH';

export type ConditionExpr =
  | { type: 'literal'; value: string }
  | { type: 'variable'; path: string[] }
  | { type: 'binary'; op: BinaryOp; left: ConditionExpr; right: ConditionExpr }
  | { type: 'unary'; op: 'NOT' | 'EXISTS'; operand: ConditionExpr }
  | { type: 'logical'; op: '&&' | '||'; children: ConditionExpr[] };

type TokenKind = 'identifier' | 'string' | 'number' | 'operator' | 'dot' | 'paren' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'EXISTS']);
const VARIABLE_ROOTS = new Set(['outcome', 'preferred_label', 'context', 'steps', 'artifacts']);

export class ConditionSyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (at position ${position + 1})`);
    this.name = 'ConditionSyntaxError';
    this.position = position;
  }
}

export function parseConditionExpression(expression: string): ConditionExpr {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, expression);
  return parser.parse();
}

export function collectVariablePaths(expression: ConditionExpr): string[][] {
  const paths: string[][] = [];

  const visit = (node: ConditionExpr): void => {
    if (node.type === 'variable') {
      paths.push(node.path.slice());
      return;
    }
    if (node.type === 'binary') {
      visit(node.left);
      visit(node.right);
      return;
    }
    if (node.type === 'unary') {
      visit(node.operand);
      return;
    }
    if (node.type === 'logical') {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  visit(expression);
  return paths;
}

export function collectVariableReferences(expression: ConditionExpr): Array<{ path: string[] }> {
  return collectVariablePaths(expression).map((path) => ({ path }));
}

class Parser {
  private readonly tokens: Token[];
  private readonly source: string;
  private index = 0;

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  parse(): ConditionExpr {
    const expr = this.parseOr();
    const token = this.current();
    if (token.kind !== 'eof') {
      throw this.errorAt(token, `Unexpected token '${token.value}'.`);
    }
    return expr;
  }

  private parseOr(): ConditionExpr {
    const children: ConditionExpr[] = [this.parseAnd()];

    while (this.matchLogicalOr()) {
      children.push(this.parseAnd());
    }

    if (children.length === 1) {
      return children[0]!;
    }

    return { type: 'logical', op: '||', children };
  }

  private parseAnd(): ConditionExpr {
    const children: ConditionExpr[] = [this.parseNot()];

    while (this.matchLogicalAnd()) {
      children.push(this.parseNot());
    }

    if (children.length === 1) {
      return children[0]!;
    }

    return { type: 'logical', op: '&&', children };
  }

  private parseNot(): ConditionExpr {
    if (this.matchKeyword('NOT')) {
      return {
        type: 'unary',
        op: 'NOT',
        operand: this.parseNot(),
      };
    }
    return this.parseComparison();
  }

  private parseComparison(): ConditionExpr {
    const left = this.parseExists();
    const operator = this.matchBinaryOperator();
    if (!operator) {
      return left;
    }

    const right = this.parseExists();
    return {
      type: 'binary',
      op: operator,
      left,
      right,
    };
  }

  private parseExists(): ConditionExpr {
    if (this.matchKeyword('EXISTS')) {
      const operand = this.parsePrimary();
      if (operand.type !== 'variable') {
        throw this.errorAt(this.current(), 'EXISTS must be applied to a variable reference.');
      }
      return {
        type: 'unary',
        op: 'EXISTS',
        operand,
      };
    }

    let expr = this.parsePrimary();
    while (this.matchKeyword('EXISTS')) {
      if (expr.type !== 'variable') {
        throw this.errorAt(this.current(), 'EXISTS must be applied to a variable reference.');
      }
      expr = {
        type: 'unary',
        op: 'EXISTS',
        operand: expr,
      };
    }
    return expr;
  }

  private parsePrimary(): ConditionExpr {
    const token = this.current();

    if (token.kind === 'paren' && token.value === '(') {
      this.consume();
      const expr = this.parseOr();
      const closing = this.current();
      if (closing.kind !== 'paren' || closing.value !== ')') {
        throw this.errorAt(closing, "Expected ')' to close parenthesized expression.");
      }
      this.consume();
      return expr;
    }

    if (token.kind === 'string' || token.kind === 'number') {
      this.consume();
      return { type: 'literal', value: token.value };
    }

    if (token.kind === 'identifier') {
      const segments = this.readIdentifierChain();
      const root = segments[0]!;
      if (VARIABLE_ROOTS.has(root)) {
        return { type: 'variable', path: segments };
      }
      return { type: 'literal', value: segments.join('.') };
    }

    if (token.kind === 'eof') {
      throw this.errorAt(token, 'Unexpected end of condition expression.');
    }

    throw this.errorAt(token, `Unexpected token '${token.value}'.`);
  }

  private readIdentifierChain(): string[] {
    const first = this.current();
    if (first.kind !== 'identifier') {
      throw this.errorAt(first, 'Expected identifier.');
    }

    const segments: string[] = [first.value];
    this.consume();

    while (this.current().kind === 'dot') {
      this.consume();
      const next = this.current();
      if (next.kind !== 'identifier') {
        throw this.errorAt(next, 'Expected identifier after dot.');
      }
      segments.push(next.value);
      this.consume();
    }

    return segments;
  }

  private matchBinaryOperator(): BinaryOp | null {
    const token = this.current();

    if (token.kind === 'operator') {
      if (token.value === '=' || token.value === '!=' || token.value === '<' || token.value === '>' || token.value === '<=' || token.value === '>=') {
        this.consume();
        return token.value;
      }
      return null;
    }

    if (token.kind === 'identifier') {
      const upper = token.value.toUpperCase();
      if (upper === 'CONTAINS' || upper === 'STARTS_WITH' || upper === 'ENDS_WITH') {
        this.consume();
        return upper;
      }
    }

    return null;
  }

  private matchLogicalAnd(): boolean {
    const token = this.current();
    if (token.kind === 'operator' && token.value === '&&') {
      this.consume();
      return true;
    }
    if (token.kind === 'identifier' && token.value.toUpperCase() === 'AND') {
      this.consume();
      return true;
    }
    return false;
  }

  private matchLogicalOr(): boolean {
    const token = this.current();
    if (token.kind === 'operator' && token.value === '||') {
      this.consume();
      return true;
    }
    if (token.kind === 'identifier' && token.value.toUpperCase() === 'OR') {
      this.consume();
      return true;
    }
    return false;
  }

  private matchKeyword(keyword: string): boolean {
    const token = this.current();
    if (token.kind === 'identifier' && token.value.toUpperCase() === keyword) {
      this.consume();
      return true;
    }
    return false;
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private consume(): void {
    this.index += 1;
  }

  private errorAt(token: Token, message: string): ConditionSyntaxError {
    const position = token.kind === 'eof' ? this.source.length : token.start;
    return new ConditionSyntaxError(message, position);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const { value, nextIndex } = readQuotedString(source, index);
      tokens.push({
        kind: 'string',
        value,
        start: index,
        end: nextIndex,
      });
      index = nextIndex;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({
        kind: 'paren',
        value: char,
        start: index,
        end: index + 1,
      });
      index += 1;
      continue;
    }

    if (char === '.') {
      tokens.push({ kind: 'dot', value: '.', start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (isOperatorStart(char)) {
      const token = readOperator(source, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    if (isNumberStart(char)) {
      const token = readNumber(source, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    if (isIdentifierStart(char)) {
      const token = readIdentifier(source, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    throw new ConditionSyntaxError(`Unexpected character '${char}'.`, index);
  }

  tokens.push({
    kind: 'eof',
    value: '<eof>',
    start: source.length,
    end: source.length,
  });

  return tokens;
}

function readQuotedString(source: string, startIndex: number): { value: string; nextIndex: number } {
  let index = startIndex + 1;
  let value = '';

  while (index < source.length) {
    const char = source[index]!;

    if (char === '"') {
      return {
        value,
        nextIndex: index + 1,
      };
    }

    if (char === '\\') {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        throw new ConditionSyntaxError('Unterminated escape sequence in string literal.', index);
      }
      value += decodeEscape(escaped);
      index += 2;
      continue;
    }

    value += char;
    index += 1;
  }

  throw new ConditionSyntaxError('Unterminated string literal.', startIndex);
}

function decodeEscape(value: string): string {
  if (value === '"' || value === '\\' || value === '/') return value;
  if (value === 'n') return '\n';
  if (value === 'r') return '\r';
  if (value === 't') return '\t';
  if (value === 'b') return '\b';
  if (value === 'f') return '\f';
  return value;
}

function readOperator(source: string, startIndex: number): Token {
  const two = source.slice(startIndex, startIndex + 2);
  if (two === '&&' || two === '||' || two === '!=' || two === '<=' || two === '>=') {
    return {
      kind: 'operator',
      value: two,
      start: startIndex,
      end: startIndex + 2,
    };
  }

  const one = source[startIndex]!;
  if (one === '=' || one === '<' || one === '>') {
    return {
      kind: 'operator',
      value: one,
      start: startIndex,
      end: startIndex + 1,
    };
  }

  throw new ConditionSyntaxError(`Unexpected character '${one}'.`, startIndex);
}

function readNumber(source: string, startIndex: number): Token {
  let index = startIndex;
  let seenDot = false;

  while (index < source.length) {
    const char = source[index]!;
    if (char === '.') {
      if (seenDot) break;
      seenDot = true;
      index += 1;
      continue;
    }
    if (!isDigit(char)) break;
    index += 1;
  }

  return {
    kind: 'number',
    value: source.slice(startIndex, index),
    start: startIndex,
    end: index,
  };
}

function readIdentifier(source: string, startIndex: number): Token {
  let index = startIndex;
  while (index < source.length && isIdentifierPart(source[index]!)) {
    index += 1;
  }

  const raw = source.slice(startIndex, index);
  const upper = raw.toUpperCase();
  if (KEYWORDS.has(upper)) {
    return {
      kind: 'identifier',
      value: upper,
      start: startIndex,
      end: index,
    };
  }

  return {
    kind: 'identifier',
    value: raw,
    start: startIndex,
    end: index,
  };
}

function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

function isIdentifierStart(value: string): boolean {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || value === '_';
}

function isIdentifierPart(value: string): boolean {
  return isIdentifierStart(value) || isDigit(value);
}

function isNumberStart(value: string): boolean {
  return isDigit(value);
}

function isDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isOperatorStart(value: string): boolean {
  return value === '&' || value === '|' || value === '!' || value === '=' || value === '<' || value === '>';
}
