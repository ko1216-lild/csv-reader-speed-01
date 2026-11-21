// A fast CSV reader that returns exactly csv-reader 1.0.0's answer for every input.
//
// The reading policy (make.fun's broken-row policy, reproduced exactly):
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside
//     it is one quote), each CRLF or lone CR inside it is read as LF, and what follows its
//     closing quote up to the next comma or line break is appended as it stands (error
//     quote_junk, when anything was appended); a quote that never closes is a literal
//     character and the text after it is read again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (error short_row,
//     with fields: its field count) or cut (error long_row, with extra: the cut fields) to
//     the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every
//     LF, CRLF and lone CR inside a quoted field counted), row its record's index in rows
//     (null for the header), in the order met.
//
// Speed comes from never building a field character by character: each field reader scans
// char codes only to find where its segments end, and the value is assembled from slices
// of the input between the special characters. No state is kept between calls.

// How a field ended.
const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // The field most recently read: its value, how it ended, and how many characters the
  // last unquoted scan kept (the quote_junk test reads this).
  let fValue = '';
  let fEnded = ENDED_END;
  let fAdded = 0;

  // Reads unquoted characters onto `prefix` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Sets fValue, fEnded and fAdded.
  function readUnquoted(prefix) {
    let value = prefix;
    let added = 0;
    let seg = pos; // the start of the verbatim run not yet copied into value
    let i = pos;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) { // ','
        if (i > seg) { value += text.slice(seg, i); added += i - seg; }
        pos = i + 1;
        fValue = value; fEnded = ENDED_COMMA; fAdded = added;
        return;
      }
      if (c === 10) { // LF
        if (i > seg) { value += text.slice(seg, i); added += i - seg; }
        pos = i + 1;
        line += 1;
        fValue = value; fEnded = ENDED_BREAK; fAdded = added;
        return;
      }
      if (c === 13) { // CR
        if (text.charCodeAt(i + 1) === 10) { // CRLF
          if (i > seg) { value += text.slice(seg, i); added += i - seg; }
          pos = i + 2;
          line += 1;
          fValue = value; fEnded = ENDED_BREAK; fAdded = added;
          return;
        }
        // A lone CR is dropped, and the verbatim run restarts after it.
        if (i > seg) { value += text.slice(seg, i); added += i - seg; }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    if (len > seg) { value += text.slice(seg, len); added += len - seg; }
    pos = len;
    fValue = value; fEnded = ENDED_END; fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let seg = pos + 1; // the start of the verbatim run not yet copied out
    let i = seg;
    let parts = null; // value pieces, once the field is not a single slice
    let value = '';
    let closed = false;
    while (i < len) {
      // Jump straight to the next quote: only CR and LF can matter before it, and the
      // run up to it is short, so it is checked character by character. If no quote is
      // left at all, the field never closes and the scan can stop at once: everything
      // it would read is discarded by the unterminated fallback below.
      const nq = text.indexOf('"', i);
      if (nq === -1) { i = len; break; }
      while (i < nq) {
        const c = text.charCodeAt(i);
        if (c === 10) { // LF stays as it stands, and still counts a line
          line += 1;
          i += 1;
          continue;
        }
        if (c === 13) { // CR: CRLF and a lone CR inside quotes are each one LF
          if (parts === null) parts = [];
          if (i > seg) parts.push(text.slice(seg, i));
          parts.push('\n');
          line += 1;
          i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
          seg = i;
          continue;
        }
        i += 1;
      }
      // The quote at i: a doubled one is an escaped quote inside the field.
      if (text.charCodeAt(i + 1) === 34) {
        if (parts === null) parts = [];
        if (i > seg) parts.push(text.slice(seg, i));
        parts.push('"');
        i += 2;
        seg = i;
        continue;
      }
      // The closing quote.
      if (parts === null) {
        value = text.slice(seg, i);
      } else {
        if (i > seg) parts.push(text.slice(seg, i));
        value = parts.join('');
      }
      pos = i + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted, with the line count restored to the opening quote's line.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (pos >= len) { fValue = value; fEnded = ENDED_END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fValue = value; fEnded = ENDED_COMMA; return; }
    if (c === 10) { pos += 1; line += 1; fValue = value; fEnded = ENDED_BREAK; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = ENDED_BREAK; return;
    }
    // What follows the closing quote is appended as it stands.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
