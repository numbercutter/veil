export type EntityType = "EMAIL" | "PHONE" | "SSN" | "CARD" | "IP" | "IBAN" | "NAME" | "TERM";

export type Match = { type: EntityType; start: number; end: number; value: string };

export type DetectOptions = { names?: string[]; terms?: string[] };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const PHONE_NA = /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)/g;
const PHONE_INTL = /(?<![\w+])\+\d{1,3}(?:[\s.-]?(?:\(\d{1,4}\)|\d{1,4})){2,5}(?![\w-])/g;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function collect(text: string, pattern: RegExp, type: EntityType, accept: (value: string) => boolean = () => true): Match[] {
  const found: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    if (accept(match[0])) found.push({ type, start: match.index!, end: match.index! + match[0].length, value: match[0] });
  }
  return found;
}

function ibans(text: string): Match[] {
  const found: Match[] = [];
  for (const match of text.matchAll(IBAN)) {
    let value = match[0];
    while (value.length >= 15) {
      if (ibanValid(value.replace(/ /g, ""))) {
        found.push({ type: "IBAN", start: match.index!, end: match.index! + value.length, value });
        break;
      }
      const cut = value.lastIndexOf(" ");
      value = cut > 0 ? value.slice(0, cut) : value.slice(0, -1);
    }
  }
  return found;
}

function listed(text: string, entries: string[] | undefined, type: EntityType): Match[] {
  const words = [...new Set((entries ?? []).map((e) => e.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return [];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return collect(text, new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu"), type);
}

export function detect(text: string, options: DetectOptions = {}): Match[] {
  const candidates = [
    ...collect(text, EMAIL, "EMAIL"),
    ...ibans(text),
    ...collect(text, CARD, "CARD", (v) => {
      const digits = v.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    }),
    ...collect(text, SSN, "SSN"),
    ...collect(text, PHONE_NA, "PHONE"),
    ...collect(text, PHONE_INTL, "PHONE", (v) => {
      const digits = v.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15;
    }),
    ...collect(text, IPV4, "IP"),
    ...listed(text, options.names, "NAME"),
    ...listed(text, options.terms, "TERM"),
  ];
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const chosen: Match[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    chosen.push(candidate);
    cursor = candidate.end;
  }
  return chosen;
}

export function normalize(type: EntityType, value: string): string {
  switch (type) {
    case "EMAIL":
    case "NAME":
    case "TERM":
      return value.toLowerCase().replace(/\s+/g, " ");
    case "PHONE": {
      const digits = value.replace(/\D/g, "");
      return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    }
    case "SSN":
    case "CARD":
      return value.replace(/\D/g, "");
    case "IBAN":
      return value.replace(/ /g, "").toUpperCase();
    case "IP":
      return value;
  }
}
