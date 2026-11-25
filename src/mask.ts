import { detect, normalize, type DetectOptions, type EntityType } from "./detect";

export type Masked = { type: EntityType; placeholder: string; value: string; normalized: string };

export type SessionData = { id: string; entries: Array<{ type: EntityType; placeholder: string; value: string; normalized: string }> };

const PLACEHOLDER = /⟦([A-Z]+)_(\d+)⟧/g;

export class Session {
  readonly id: string;
  private readonly byKey = new Map<string, Masked>();
  private readonly byPlaceholder = new Map<string, Masked>();
  private readonly counts = new Map<EntityType, number>();

  constructor(id: string = crypto.randomUUID()) {
    this.id = id;
  }

  static from(data: SessionData): Session {
    const session = new Session(data.id);
    for (const entry of data.entries) session.add(entry);
    return session;
  }

  placeholderFor(type: EntityType, value: string): Masked {
    const normalized = normalize(type, value);
    const key = `${type}:${normalized}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const next = (this.counts.get(type) ?? 0) + 1;
    const entry = { type, placeholder: `⟦${type}_${next}⟧`, value, normalized };
    this.add(entry);
    return entry;
  }

  lookup(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  toJSON(): SessionData {
    return { id: this.id, entries: [...this.byPlaceholder.values()] };
  }

  private add(entry: Masked): void {
    this.byKey.set(`${entry.type}:${entry.normalized}`, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    const n = Number(entry.placeholder.match(/_(\d+)⟧$/)![1]);
    this.counts.set(entry.type, Math.max(this.counts.get(entry.type) ?? 0, n));
  }
}

export type MaskOptions = DetectOptions & { session?: Session };

export type MaskResult = { text: string; session: Session; found: Masked[] };

export function mask(text: string, options: MaskOptions = {}): MaskResult {
  const session = options.session ?? new Session();
  const found: Masked[] = [];
  let out = "";
  let cursor = 0;
  for (const match of detect(text, options)) {
    const entry = session.placeholderFor(match.type, match.value);
    found.push(entry);
    out += text.slice(cursor, match.start) + entry.placeholder;
    cursor = match.end;
  }
  return { text: out + text.slice(cursor), session, found };
}

export type UnmaskOptions = { json?: boolean };

export function unmask(text: string, session: Session, options: UnmaskOptions = {}): string {
  return text.replace(PLACEHOLDER, (placeholder) => {
    const value = session.lookup(placeholder);
    if (value === undefined) return placeholder;
    return options.json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

const PARTIAL = /⟦[A-Z]*(?:_\d*)?$/;
const LONGEST_PLACEHOLDER = 32;

export class StreamUnmasker {
  private held = "";
  readonly restored: string[] = [];

  constructor(
    private readonly session: Session,
    private readonly options: UnmaskOptions = {},
  ) {}

  push(chunk: string): string {
    const text = this.held + chunk;
    const open = text.lastIndexOf("⟦");
    const tail = open >= 0 ? text.slice(open) : "";
    const cut = open >= 0 && tail.length <= LONGEST_PLACEHOLDER && PARTIAL.test(tail) ? open : text.length;
    this.held = text.slice(cut);
    return this.release(text.slice(0, cut));
  }

  flush(): string {
    const text = this.held;
    this.held = "";
    return this.release(text);
  }

  get pending(): boolean {
    return this.held.length > 0;
  }

  private release(text: string): string {
    this.restored.push(...placeholders(text));
    return unmask(text, this.session, this.options);
  }
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[0]);
}
