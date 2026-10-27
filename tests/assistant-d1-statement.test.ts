import {env} from "cloudflare:test";
import {expect,it} from "vitest";
import {compactStatement} from "../assistant/d1-statement";
it("executes over 100 repeated parameters with ordered bindings while retaining typed values",async()=>{
  const sql=`SELECT ? IN (${Array(150).fill("?").join(",")}) AS matched,typeof(?) AS number,typeof(?) AS text,? IS NULL AS absent`;
  const values=[7,...Array(150).fill(7),1,"1",null];
  const native=await env.DB.prepare("SELECT typeof(?) AS number,typeof(?) AS text").bind(1,"1").first();
  expect(await compactStatement(env.DB,sql,values).first()).toEqual({matched:1,...native,absent:1});
});
it("preserves quoted question marks, escaped delimiters and comments and never interpolates private values",async()=>{
  const value="private' OR 1=1 -- ? @ : $",sql="SELECT ? AS [question?], '?' AS literal, 'it''s?' AS escaped, ? AS `other?`, ? AS \"double?\" /* ? @x :x $x */ -- ?\n";
  expect(await compactStatement(env.DB,sql,[value,value,value]).first()).toEqual({"question?":value,literal:"?",escaped:"it's?","other?":value,"double?":value});
});
it.each(["SELECT ?1","SELECT :named","SELECT @named","SELECT $named","SELECT '?' , ?","SELECT /* never closed","SELECT 'never closed","SELECT \"never closed","SELECT `never closed","SELECT [never closed"])("rejects unsupported or unmatched host SQL before query execution: %s",sql=>{
  expect(()=>compactStatement(env.DB,sql,[])).toThrow();
});
it("refuses extra values, unsupported types and more than 100 distinct parameters",()=>{
  expect(()=>compactStatement(env.DB,"SELECT 1",["extra"])).toThrow();
  for(const value of [undefined,true,false,NaN,Infinity,{},[]])expect(()=>compactStatement(env.DB,"SELECT ?",[value])).toThrow();
  expect(()=>compactStatement(env.DB,`SELECT 1 IN (${Array(101).fill("?").join(",")})`,Array.from({length:101},(_,i)=>i))).toThrow();
});
