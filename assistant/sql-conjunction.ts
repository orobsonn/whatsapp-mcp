/** Fixed host predicates only. Associative SQL AND with logarithmic depth;
 * preserves three-valued truth, order of placeholders and every predicate. */
export function sqlAnd(parts:readonly string[]):string{if(!parts.length)return '1';if(parts.length===1)return parts[0];const mid=Math.floor(parts.length/2);return `(${sqlAnd(parts.slice(0,mid))}) AND (${sqlAnd(parts.slice(mid))})`;}
