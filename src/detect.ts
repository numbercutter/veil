export type EntityType = "EMAIL" | "PHONE" | "SSN" | "CARD" | "IP" | "IBAN" | "DOB" | "ADDRESS" | "NINO" | "NAME" | "TERM";

export type Match = { type: EntityType; start: number; end: number; value: string };

export type DetectOptions = { names?: string[]; terms?: string[] };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
const CARD = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const PHONE_NA = /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)/g;
const PHONE_INTL = /(?<![\w+])\+\d{1,3}(?:[\s.-]?(?:\(\d{1,4}\)|\d{1,4})){2,5}(?![\w-])/g;
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]*\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DATE = `(?:\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+\\d{4}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`;
const DOB = new RegExp(`\\b(?:DOB|D\\.O\\.B\\.?|date\\s+of\\s+birth|birth\\s*date|born(?:\\s+on)?)\\s*(?:[:=-]|is|was)?\\s*(${DATE})(?![\\d/.-]*\\d)`, "gi");
const SUFFIX = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Square|Sq|Trail|Trl)";
const UNIT = "(?:,?[ \\t]*(?:Apt|Apartment|Suite|Ste|Unit|#)\\.?[ \\t]*[A-Za-z0-9-]+)?";
const ADDRESS = new RegExp(`(?<![\\w.,-])\\d{1,6}[A-Za-z]?(?:-\\d{1,4})?[ \\t]+(?:[NSEW]\\.?[ \\t]+)?(?:\\d{1,3}(?:st|nd|rd|th)|[A-Z][a-z]+)(?:[ \\t]+[A-Z][a-z]+){0,3}[ \\t]+${SUFFIX}\\b\\.?(?:[ \\t]+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?${UNIT}`, "g");
const NINO = /(?<![A-Za-z0-9])(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g;

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

export function plausibleDate(text: string): boolean {
  const numeric = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(text);
  if (!numeric) return true;
  const [a, b, c] = numeric.slice(1).map(Number);
  const [day, month] = numeric[1].length === 4 ? [c, b] : a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function birthDates(text: string): Match[] {
  const found: Match[] = [];
  for (const match of text.matchAll(DOB)) {
    const value = match[1];
    if (!plausibleDate(value)) continue;
    const start = match.index! + match[0].lastIndexOf(value);
    found.push({ type: "DOB", start, end: start + value.length, value });
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
    ...birthDates(text),
    ...collect(text, ADDRESS, "ADDRESS"),
    ...collect(text, NINO, "NINO"),
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
    case "ADDRESS":
      return value.toLowerCase().replace(/\s+/g, " ");
    case "NINO":
      return value.replace(/\s/g, "").toUpperCase();
    case "DOB":
      return value.toLowerCase().replace(/\s+/g, " ").replace(/,/g, "");
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
