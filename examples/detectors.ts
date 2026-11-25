import { mask } from "../src";

const shouldMask = [
  "DOB: 04/07/1986",
  "Patient born on March 3, 1972 in Leeds",
  "date of birth 1990-11-02",
  "D.O.B. 3rd Feb 2001",
  "Ship to 1600 Pennsylvania Ave NW, Washington",
  "Lives at 221 Baker Street, Apt 2B",
  "Return to 4 W 43rd St.",
  "Send it to 12 Oak Lane by Friday",
  "NI number AB 12 34 56 C",
  "NINO: JG103748A",
];

const shouldNotMask = [
  "The meeting is on 04/07/1986",
  "Release date 2024-03-01, born of a long review",
  "We shipped 400 units on Main Street",
  "Store 12 on the high street",
  "Take 3 Advil and rest",
  "Version 2 Way Merge is done",
  "Order AB123456 shipped",
  "Postcode SW1A 1AA",
  "Tracking QQ 12 34 56 C",
  "Room 4 Building B",
];

const knownGaps = [
  "Play track 3 Abbey Road again",
  "lives at 12 oak lane",
  "Flat 2, Rose Court, Leeds",
  "born 1986",
  "PO Box 4410",
];

function row(text: string) {
  const { text: masked, found } = mask(text);
  return { masked, types: found.map((item) => item.type).join(",") || "-" };
}

let misses = 0;
let falsePositives = 0;

console.log("should be masked:");
for (const text of shouldMask) {
  const { masked, types } = row(text);
  if (types === "-") misses++;
  console.log(`  ${types === "-" ? "MISS" : "ok  "} ${text.padEnd(46)} -> ${masked}`);
}

console.log("\nshould be left alone:");
for (const text of shouldNotMask) {
  const { masked, types } = row(text);
  if (types !== "-") falsePositives++;
  console.log(`  ${types === "-" ? "ok  " : "HIT "} ${text.padEnd(46)} -> ${masked}`);
}

console.log("\nknown gaps (a false positive, then misses):");
for (const text of knownGaps) console.log(`       ${text.padEnd(46)} -> ${row(text).masked}`);

console.log(`\n${shouldMask.length - misses}/${shouldMask.length} caught, ${falsePositives}/${shouldNotMask.length} false positives`);
