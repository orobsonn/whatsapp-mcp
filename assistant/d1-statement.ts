/** Host SQL only: reuse equal primitive bindings using D1's ordered parameters.
 * Compile the WHOLE statement, never an embeddable guard. Values stay bound.
 * https://developers.cloudflare.com/d1/worker-api/prepared-statements/ */
export function compactStatement(db: D1Database, sql: string, values: readonly unknown[]): D1PreparedStatement {
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
    if (ch === ":" || ch === "@" || ch === "$" || ch === "?" && /[0-9]/.test(sql[i + 1] ?? "")) throw new Error("statement_parameter_format");
    if (ch !== "?") { output += ch; i++; continue; }
    const value = values[consumed++];
    if (value !== null && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("statement_parameter_type");
    let position = positions.get(value as string | number | null);
    if (position === undefined) { unique.push(value as string | number | null); positions.set(value as string | number | null, position = unique.length); }
    output += `?${position}`; i++;
  }
  if (consumed !== values.length || unique.length > 100) throw new Error("statement_parameter_count");
  return db.prepare(output).bind(...unique);
}
