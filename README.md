<p align="center"><img src="assets/banner.svg" alt="veil" width="100%"></p>

**The model sees the shape, never the person.**

veil swaps personal data for stable placeholders like `⟦EMAIL_1⟧` before text reaches a model, and puts the real values back in the answer. It runs as a library or as a drop-in proxy for OpenAI-compatible chat completions and the Anthropic Messages API, streaming or not, and keeps a tamper-evident audit log that never holds a raw value.

## Quick start

Needs [Bun](https://bun.sh) 1.1 or newer. No accounts, no API keys: the example talks to a local mock model.

```sh
git clone https://github.com/numbercutter/veil && cd veil
bun examples/proxy.ts
```

```
app sent:
  Refund Maria Okafor (maria.okafor@example.com, +1 415 555 0132). Card 4242 4242 4242 4242, ...

upstream saw:
  Refund ⟦NAME_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧). Card ⟦CARD_1⟧, SSN ⟦SSN_1⟧, IBAN ⟦IBAN_1⟧, last login from ⟦IP_1⟧.

app got back:
  Noted. I will follow up with Refund Maria Okafor (maria.okafor@example.com, +1 415 555 0132). ...

raw values in upstream traffic: 0
raw values in audit log:        0

verify-log: ok, 2 entries
verify-log after editing one field: line 1: content does not match its hash
```

Two more offline examples:

```sh
bun examples/stream.ts      # streaming through both APIs, mock model sends 3-character chunks
bun examples/detectors.ts   # spot checks for the date of birth, address and NINO detectors
```

```
1. OpenAI chat completions, stream: true, with a tool
  upstream saw:   Write to ⟦NAME_1⟧ at ⟦EMAIL_1⟧, DOB ⟦DOB_1⟧, ⟦ADDRESS_1⟧, NINO ⟦NINO_1⟧.
  upstream streamed 51 chunks of 3 characters, in 7-byte network writes; 5 placeholders were cut across chunks
  app read:       Noted. I will follow up with Write to Maria Okafor at maria.okafor@example.com, DOB 04/07/1986, 1600 Pennsylvania Ave NW Apt 4, NINO AB 12 34 56 C.
  tool arguments: {"to":"maria.okafor@example.com","subject":"Your refund"}  (parses: maria.okafor@example.com)
  restored exactly: true
```

## Usage

### Library

```ts
import { mask, unmask } from "@numbercutter/veil";

const { text, session } = mask("Email ada@example.com about card 4111 1111 1111 1111", {
  names: ["Ada Lovelace"],
  terms: ["Project Nightjar"],
});
// text: "Email ⟦EMAIL_1⟧ about card ⟦CARD_1⟧"

const answer = await callYourModel(text);
console.log(unmask(answer, session));
```

Pass the same `session` to several `mask` calls and a value keeps its placeholder across them. `session.toJSON()` and `Session.from()` let you store the vault between processes; it holds the raw values, so treat it like the data itself.

| placeholder | detects |
|---|---|
| `EMAIL` | email addresses |
| `PHONE` | North American numbers with separators, `+` international numbers |
| `SSN` | US social security numbers written `123-45-6789` |
| `CARD` | 13 to 19 digit card numbers that pass the Luhn check |
| `IP` | IPv4 addresses |
| `IBAN` | IBANs that pass the mod-97 check, compact or in groups of four |
| `DOB` | a date right after a label: `DOB`, `D.O.B.`, `date of birth`, `birth date`, `born (on)`. Numeric, ISO and month-name dates; only the date is replaced |
| `ADDRESS` | US-style street lines: house number, capitalised street name, suffix (`Street`, `Ave`, `Rd`, ...), optional direction and `Apt`/`Suite`/`Unit` |
| `NINO` | UK National Insurance numbers with valid prefix letters and an `A`-`D` suffix, compact or spaced |
| `NAME`, `TERM` | your own lists, matched case-insensitively on word boundaries |

`StreamUnmasker` does the same for text that arrives in pieces: `push(chunk)` returns what is safe to show and holds back a trailing partial placeholder until the next chunk completes it; `flush()` returns the rest.

### Proxy

Set your client's base URL to veil instead of the provider. Auth headers (`Authorization`, `x-api-key`, `anthropic-version`, `anthropic-beta`, OpenAI org and project) are passed through untouched.

```sh
VEIL_UPSTREAM=https://api.openai.com/v1 \
VEIL_ANTHROPIC_UPSTREAM=https://api.anthropic.com/v1 \
  bun src/cli.ts serve --port 8787 --names "Ada Lovelace"
# OpenAI client base URL:    http://127.0.0.1:8787/v1
# Anthropic client base URL: http://127.0.0.1:8787
```

| route | upstream | masks | restores |
|---|---|---|---|
| `POST /v1/chat/completions` | `VEIL_UPSTREAM` + `/chat/completions` | message text, text parts, tool-call arguments | message content and tool-call arguments, also in `stream: true` deltas |
| `POST /v1/messages` | `VEIL_ANTHROPIC_UPSTREAM` + `/messages` | `system`, text blocks, `tool_use` input, `tool_result` content | text blocks and `tool_use` input, also `text_delta` and `input_json_delta` events when streaming |

Set either upstream or both; a route without one answers 404.

To try it offline, run `bun examples/mock-upstream.ts` in one terminal, then:

```sh
VEIL_UPSTREAM=http://127.0.0.1:9999/v1 VEIL_ANTHROPIC_UPSTREAM=http://127.0.0.1:9999/v1 bun src/cli.ts serve
curl -s localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"m","messages":[{"role":"user","content":"Email jo@corp.io about 4111 1111 1111 1111"}]}'
curl -sN localhost:8787/v1/messages -H 'content-type: application/json' \
  -d '{"model":"m","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Email jo@corp.io"}]}'
bun src/cli.ts verify-log
```

The mock terminal prints `[{"role":"user","content":"Email ⟦EMAIL_1⟧ about ⟦CARD_1⟧"}]`.

### CLI

```sh
bun src/cli.ts mask "Call (415) 555-0132 from 10.0.0.7"          # Call ⟦PHONE_1⟧ from ⟦IP_1⟧
bun src/cli.ts mask "NINO AB 12 34 56 C, born on 3 June 1980"     # NINO ⟦NINO_1⟧, born on ⟦DOB_1⟧
echo "jo@corp.io" | bun src/cli.ts mask --json                    # masked text plus the vault
bun src/cli.ts verify-log .veil/audit.jsonl                       # exit 1 on tampering
```

## How it works

Each detector proposes matches; overlaps resolve to the earliest, longest one. Every distinct value gets one placeholder per session, so `ADA@example.com` and `ada@example.com` both become `⟦EMAIL_1⟧`, and the model can still tell people apart. Unmasking replaces every placeholder it knows and leaves unknown ones alone.

The proxy masks the request, forwards it, and unmasks the answer. For `stream: true` it reads the upstream's server-sent events, keeps one unmasker per choice, content block and tool call, and rewrites each delta. A delta that ends inside a placeholder (`⟦EMA`) is held back until the next delta completes it, so the client may get an empty delta followed by the restored value. Held text is released before `finish_reason`, `content_block_stop` and `[DONE]`. Values restored inside tool-call arguments and `input_json_delta` are JSON-escaped so the arguments still parse.

Each request writes two lines to `.veil/audit.jsonl`: what was masked and what was restored. A line records the placeholder, its type and an HMAC-SHA256 of the value, keyed by `.veil/audit.key` (or `VEIL_AUDIT_KEY`) so short values like SSNs cannot be brute-forced from the log alone. Every line carries the hash of the line before it, so editing, reordering or deleting a line breaks the chain from that line on.

## Limits

- Pattern matching, not understanding. Names and other free-text identifiers are only caught if you list them. Dates of birth need a label next to them; addresses must be US-style with a capitalised street name and a known suffix, so UK and other address formats, PO boxes and lower-case addresses are missed, and a phrase like "track 3 Abbey Road" is masked. National IDs other than US SSNs and UK NINOs are not detected. `examples/detectors.ts` prints the spot checks, including known gaps.
- Two APIs. OpenAI-compatible `/v1/chat/completions` and Anthropic `/v1/messages`; the OpenAI Responses API, embeddings and other routes are not proxied.
- Images, audio, documents and Anthropic `thinking` blocks pass through as they are, unmasked and unrestored.
- A streamed placeholder longer than 32 characters, or one the model splits with other text in between, is not reassembled.
- If a model rewrites a placeholder (drops the brackets, changes the number), that spot cannot be restored.
- Equal values restore to the first spelling seen in the session.
- The log chain shows edits within the file, but not a cut from the end. Keep the `head` hash printed by `verify-log` somewhere else if that matters.
- The vault lives in memory for the length of one proxied request; veil itself stores no raw values on disk.

## Works with

[meter](https://github.com/numbercutter/meter) logs spend for calls sent through veil, since veil returns the provider's usage fields untouched, and [glass](https://github.com/numbercutter/glass) shows the runs, where anything recorded past veil holds placeholders instead of personal data.

<sub>A numbercutter instrument · MIT</sub>
