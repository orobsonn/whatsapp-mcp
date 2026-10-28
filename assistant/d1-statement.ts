/** Host SQL only: reuse equal primitive bindings using D1's ordered parameters.
 * Compile the WHOLE statement, never an embeddable guard. Values stay bound.
 * https://developers.cloudflare.com/d1/worker-api/prepared-statements/ */
function compile(sql: string, values: readonly unknown[], parameter: (position: number) => string, strict = false) {
  const unique: (string | number | null)[] = [], positions = new Map<string | number | null, number>();
  let output = "", consumed = 0;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const end = ch === "[" ? "]" : ch, start = i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] !== end) continue;
        if (end !== "]" && sql[i] === end) { i++; continue; }
        closed = true; break;
      }
      if (!closed) throw new Error("statement_unclosed_quote");
      output += sql.slice(start, i); continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i), next = end < 0 ? sql.length : end + 1;
      output += sql.slice(i, next); i = next; continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("statement_unclosed_comment");
      output += sql.slice(i, end + 2); i = end + 2; continue;
    }
    if (strict && ch === ";") throw new Error("statement_multiple");
    if (ch === ":" || ch === "@" || ch === "$" || ch === "?" && /[0-9]/.test(sql[i + 1] ?? "")) throw new Error("statement_parameter_format");
    if (ch !== "?") { output += ch; i++; continue; }
    const value = values[consumed++];
    if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("statement_parameter_type");
    let position = positions.get(value as string | number | null);
    if (position === undefined) { unique.push(value as string | number | null); positions.set(value as string | number | null, position = unique.length); }
    output += parameter(position); i++;
  }
  if (consumed !== values.length) throw new Error("statement_parameter_count");
  return { output, unique };
}
export function compactStatement(db: D1Database, sql: string, values: readonly unknown[]): D1PreparedStatement {
  const { output, unique } = compile(sql, values, position => `?${position}`);
  if (unique.length > 100) throw new Error("statement_parameter_count");
  return db.prepare(output).bind(...unique);
}
/** Complete host SELECT/UPDATE/INSERT statements only. A single bound JSON
 * packet retains all proof values when distinct revisions exceed D1's100binds.
 * Reusing ?1 avoids additional CTEs/subqueries and their expression depth.
 * No value or identifier from a message/model is interpolated into SQL. */
export function jsonStatement(db: D1Database, sql: string, values: readonly unknown[]): D1PreparedStatement {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (!/^\s*(SELECT|UPDATE|INSERT)\b/i.test(sql) || bytes(sql) > 100000 || values.length > 4096) throw new Error("statement_capacity");
  const { output, unique } = compile(sql, values, position => `json_extract(?1,'$[${position - 1}]')`, true);
  for (const value of unique) {
    if (typeof value === "string" && (value.includes("\0") || new TextDecoder().decode(new TextEncoder().encode(value)) !== value)
      || typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("statement_parameter_type");
  }
  const packet = JSON.stringify(unique), statement = output;
  if (bytes(statement) > 100000 || bytes(packet) > 131072) throw new Error("statement_capacity");
  return unique.length ? db.prepare(statement).bind(packet) : db.prepare(statement);
}
