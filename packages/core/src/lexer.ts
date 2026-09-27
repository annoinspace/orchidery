import type { Position, Span } from "./ast.js";
import { OrchidError } from "./diagnostics.js";

const OPEN = "([{";
const CLOSE = ")]}";

/**
 * A cursor over source text. Orchidery's grammar is mostly structural with
 * raw TypeScript leaves, so a character-level scanner with bracket-balanced
 * raw capture is simpler and more robust than a token stream.
 */
export class Scanner {
  pos = 0;
  line = 1;
  col = 1;

  constructor(public src: string, public file?: string) {}

  get eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(n = 0): string {
    return this.src[this.pos + n] ?? "";
  }

  position(): Position {
    return { line: this.line, col: this.col, offset: this.pos };
  }

  spanFrom(start: Position): Span {
    return { start, end: this.position() };
  }

  advance(n = 1): void {
    for (let i = 0; i < n && this.pos < this.src.length; i++) {
      if (this.src[this.pos] === "\n") {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
      this.pos++;
    }
  }

  fail(code: string, message: string, start?: Position): never {
    const s = start ?? this.position();
    throw new OrchidError({
      code,
      severity: "error",
      message,
      file: this.file,
      range: { start: s, end: this.position() },
    });
  }

  /** Skip whitespace and comments. Returns true if a newline was crossed. */
  skipWs(includeNewlines = true): boolean {
    let sawNewline = false;
    for (;;) {
      const c = this.peek();
      if (c === "\n") {
        if (!includeNewlines) break;
        sawNewline = true;
        this.advance();
      } else if (c === " " || c === "\t" || c === "\r") {
        this.advance();
      } else if (c === "/" && this.peek(1) === "/") {
        while (!this.eof && this.peek() !== "\n") this.advance();
      } else if (c === "/" && this.peek(1) === "*") {
        this.advance(2);
        while (!this.eof && !(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === "\n") sawNewline = true;
          this.advance();
        }
        this.advance(2);
      } else {
        break;
      }
    }
    return sawNewline;
  }

  /** Skip spaces/tabs only, not newlines. */
  skipInline(): void {
    this.skipWs(false);
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  /** Consume `s` if present. */
  eat(s: string): boolean {
    if (this.startsWith(s)) {
      this.advance(s.length);
      return true;
    }
    return false;
  }

  expect(s: string): void {
    if (!this.eat(s)) this.fail("O001", `Expected \`${s}\` but found \`${this.describeNext()}\``);
  }

  describeNext(): string {
    if (this.eof) return "end of file";
    const c = this.peek();
    return c === "\n" ? "newline" : c;
  }

  isIdentStart(c: string): boolean {
    return /[A-Za-z_$]/.test(c);
  }
  isIdentPart(c: string): boolean {
    return /[A-Za-z0-9_$]/.test(c);
  }

  /** Is the upcoming word exactly `word` (not a prefix of a longer identifier)? */
  peekWord(word: string): boolean {
    return this.startsWith(word) && !this.isIdentPart(this.peek(word.length));
  }

  readIdent(): string {
    const start = this.position();
    if (!this.isIdentStart(this.peek())) this.fail("O004", `Expected identifier but found \`${this.describeNext()}\``);
    let s = "";
    while (this.isIdentPart(this.peek())) {
      s += this.peek();
      this.advance();
    }
    void start;
    return s;
  }

  /** Dotted identifier: `a.b.c`. */
  readDotted(): string {
    let s = this.readIdent();
    while (this.peek() === "." && this.isIdentStart(this.peek(1))) {
      this.advance();
      s += "." + this.readIdent();
    }
    return s;
  }

  readString(): string {
    const quote = this.peek();
    const start = this.position();
    if (quote !== '"' && quote !== "'") this.fail("O001", `Expected string but found \`${this.describeNext()}\``);
    this.advance();
    let s = "";
    for (;;) {
      if (this.eof || this.peek() === "\n") this.fail("O002", "Unterminated string", start);
      const c = this.peek();
      if (c === "\\") {
        const n = this.peek(1);
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\" };
        s += map[n] ?? n;
        this.advance(2);
        continue;
      }
      if (c === quote) {
        this.advance();
        return s;
      }
      s += c;
      this.advance();
    }
  }

  /**
   * Capture raw source until one of `stops` appears at bracket depth 0.
   * Newlines stop the capture at depth 0 when `stopAtNewline` is set.
   * Strings and template literals are skipped over. The stop character is
   * not consumed.
   */
  readRaw(stops: string, stopAtNewline: boolean): string {
    const start = this.position();
    let depth = 0;
    let out = "";
    while (!this.eof) {
      const c = this.peek();
      if (c === '"' || c === "'" || c === "`") {
        out += this.readRawString(c);
        continue;
      }
      if (c === "/" && this.peek(1) === "/") {
        while (!this.eof && this.peek() !== "\n") this.advance();
        continue;
      }
      if (depth === 0) {
        if (stops.includes(c)) break;
        if (stopAtNewline && c === "\n") break;
      }
      if (OPEN.includes(c)) depth++;
      if (CLOSE.includes(c)) {
        if (depth === 0) break; // unbalanced closer belongs to the enclosing block
        depth--;
      }
      out += c;
      this.advance();
    }
    if (depth > 0) this.fail("O003", "Unterminated bracket in expression", start);
    return out.trim();
  }

  private readRawString(quote: string): string {
    const start = this.position();
    let s = quote;
    this.advance();
    for (;;) {
      if (this.eof) this.fail("O002", "Unterminated string", start);
      const c = this.peek();
      if (c === "\n" && quote !== "`") this.fail("O002", "Unterminated string", start);
      if (c === "\\") {
        s += c + this.peek(1);
        this.advance(2);
        continue;
      }
      if (quote === "`" && c === "$" && this.peek(1) === "{") {
        s += "${";
        this.advance(2);
        s += this.readRaw("}", false);
        s += "}";
        this.advance();
        continue;
      }
      s += c;
      this.advance();
      if (c === quote) return s;
    }
  }
}
