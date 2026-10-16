// Unit tests for the moment upload-fallback check in js/moment.js: read a JPEG's own capture time
// (EXIF DateTimeOriginal, else DateTime) and refuse photos taken before the moment prompt.
// JPEG bytes are built by hand below. No database or browser needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const moment = require("../js/moment.js");

// Builds SOI + APP1 "Exif" (TIFF with IFD0 and an Exif sub-IFD) + a stub SOS/EOI.
// ifd0 / exif: { tag: "ascii value" }. Pointer to the Exif IFD is added when exif has tags.
function buildJpeg({ ifd0 = {}, exif = {}, littleEndian = false } = {}) {
  const le = littleEndian;
  const ascii = (s) => [...Buffer.from(s + "\0", "latin1")];
  const u16 = (n) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

  const exifTags = Object.entries(exif).map(([t, v]) => [Number(t), ascii(v)]);
  const ifd0Tags = Object.entries(ifd0).map(([t, v]) => [Number(t), ascii(v)]);
  const hasExif = exifTags.length > 0;
  const ifdSize = (n) => 2 + n * 12 + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0Tags.length + (hasExif ? 1 : 0));
  let dataAt = exifAt + (hasExif ? ifdSize(exifTags.length) : 0);
  const data = [];

  function ifd(tags, extra) {
    const out = [...u16(tags.length + extra.length)];
    const entries = [];
    for (const [tag, bytes] of tags) {
      let value;
      if (bytes.length <= 4) value = [...bytes, 0, 0, 0, 0].slice(0, 4);
      else {
        value = u32(dataAt);
        data.push(...bytes);
        dataAt += bytes.length;
      }
      entries.push([tag, [...u16(tag), ...u16(2), ...u32(bytes.length), ...value]]);
    }
    for (const [tag, long] of extra) entries.push([tag, [...u16(tag), ...u16(4), ...u32(1), ...u32(long)]]);
    entries.sort((a, b) => a[0] - b[0]).forEach(([, e]) => out.push(...e));
    return [...out, ...u32(0)];
  }

  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(ifd0At),
    ...ifd(ifd0Tags, hasExif ? [[0x8769, exifAt]] : []),
    ...(hasExif ? ifd(exifTags, []) : []),
  ];
  const body = [...Buffer.from("Exif\0\0", "latin1"), ...tiff, ...data];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return Uint8Array.from([0xff, 0xd8, ...app1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
}

// EXIF time strings are device-local; format a Date the way a camera would.
function exifLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const DTO = 0x9003; // DateTimeOriginal (Exif IFD)
const OTO = 0x9011; // OffsetTimeOriginal (Exif IFD)
const DT = 0x0132; // DateTime (IFD0)
const momentAt = new Date(2026, 9, 16, 14, 30, 0).getTime(); // 2:30 pm local

function refused(bytes) {
  return moment.takenBeforePrompt(moment.readCaptureTime(bytes), momentAt);
}

test("an old DateTimeOriginal is refused", () => {
  const old = new Date(momentAt - 60 * 60 * 1000); // an hour before the prompt
  const jpeg = buildJpeg({ exif: { [DTO]: exifLocal(old) } });
  assert.equal(moment.readCaptureTime(jpeg), Math.floor(old.getTime() / 1000) * 1000);
  assert.equal(refused(jpeg), true);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: exifLocal(old) } , littleEndian: true })), true, "Intel byte order");
});

test("a photo taken after the prompt is accepted", () => {
  const fresh = new Date(momentAt + 30 * 1000);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: exifLocal(fresh) } })), false);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: exifLocal(fresh) }, littleEndian: true })), false);
});

test("no EXIF, non-JPEG, and garbage are accepted", () => {
  const noExif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(moment.readCaptureTime(noExif), null);
  assert.equal(refused(noExif), false);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(refused(png), false);
  assert.equal(refused(new Uint8Array(0)), false);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: "0000:00:00 00:00:00" } })), false, "zeroed date");
  const truncated = buildJpeg({ exif: { [DTO]: exifLocal(new Date(momentAt - 3600e3)) } }).slice(0, 30);
  assert.equal(refused(truncated), false, "truncated header");
});

test("falls back to IFD0 DateTime when DateTimeOriginal is missing", () => {
  const old = new Date(momentAt - 10 * 60 * 1000);
  assert.equal(refused(buildJpeg({ ifd0: { [DT]: exifLocal(old) } })), true);
});

test("allows 2 minutes of clock skew", () => {
  const within = new Date(momentAt - 90 * 1000);
  const beyond = new Date(momentAt - 3 * 60 * 1000);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: exifLocal(within) } })), false);
  assert.equal(refused(buildJpeg({ exif: { [DTO]: exifLocal(beyond) } })), true);
});

test("OffsetTimeOriginal pins the zone instead of device-local time", () => {
  // 12:00:00 at +02:00 is 10:00:00 UTC regardless of this machine's zone.
  const jpeg = buildJpeg({ exif: { [DTO]: "2026:10:16 12:00:00", [OTO]: "+02:00" } });
  assert.equal(moment.readCaptureTime(jpeg), Date.UTC(2026, 9, 16, 10, 0, 0));
  assert.equal(moment.takenBeforePrompt(moment.readCaptureTime(jpeg), Date.UTC(2026, 9, 16, 10, 1, 0)), false);
  assert.equal(moment.takenBeforePrompt(moment.readCaptureTime(jpeg), Date.UTC(2026, 9, 16, 10, 5, 0)), true);
});

test("missing prompt time skips the check", () => {
  assert.equal(moment.takenBeforePrompt(0, NaN), false);
  assert.equal(moment.takenBeforePrompt(null, momentAt), false);
});
