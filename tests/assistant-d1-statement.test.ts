import {env} from "cloudflare:test";
import {expect,it} from "vitest";
import {compactStatement,jsonStatement} from "../assistant/d1-statement";
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
it("executes over 100 distinct JSON-bound primitives without losing indices or numeric versus text values",async()=>{
  const values=Array.from({length:125},(_,i)=>i+100);
  expect(await jsonStatement(env.DB,`SELECT ? AS first,? AS last,? AS repeated,? IS NULL AS absent,typeof(?) AS number,typeof(?) AS text,? AS literal,? AS unicode,? AS real WHERE ? IN (${values.map(()=>'?').join(',')})`,
    [100,224,100,null,1,'1','null','Olá 🧸\n"\\?',1.5,155,...values]).first()).toEqual({first:100,last:224,repeated:100,absent:1,number:'integer',text:'text',literal:'null',unicode:'Olá 🧸\n"\\?',real:1.5});
});
it("JSON binding preserves quoted syntax and treats injection strings as data",async()=>{
  const text="private' OR 1=1 -- ? @ : $";
  expect(await jsonStatement(env.DB,"SELECT ? AS [question?], '?' literal, 'it''s?' escaped, ? AS `other?` /* ? */ -- ?\n",[text,text]).first())
    .toEqual({'question?':text,literal:'?',escaped:"it's?",'other?':text});
});
it.each(["WITH x AS(SELECT 1) SELECT ?","SELECT ?; SELECT 1"])("rejects unsupported statement envelopes: %s",sql=>{
  expect(()=>jsonStatement(env.DB,sql,[1])).toThrow();
});
it("introduces no parameter CTE that a nested host query could shadow",async()=>{
  expect(await jsonStatement(env.DB,"SELECT (WITH __owner_reply_params AS(SELECT 'other' AS value) SELECT ? FROM __owner_reply_params) AS value",['bound']).first()).toEqual({value:'bound'});
});
it("executes a constant host statement without binding an unused JSON packet",async()=>{
  expect(await jsonStatement(env.DB,'SELECT 1 AS value',[]).first()).toEqual({value:1});
});
it("JSON binding refuses malformed Unicode, NUL, oversized packets and invalid parameter syntax",()=>{
  for(const value of ['\0suffix','\ud800',undefined,true,NaN,{},[]])expect(()=>jsonStatement(env.DB,'SELECT ?',[value])).toThrow();
  expect(()=>jsonStatement(env.DB,'SELECT ?',['🧸'.repeat(40000)])).toThrow();
  expect(()=>jsonStatement(env.DB,"SELECT 1 /*"+'x'.repeat(100000)+'*/',[])).toThrow();
  for(const sql of ['SELECT ?1','SELECT :named','SELECT @named','SELECT $named','SELECT ?','SELECT /* never closed'])expect(()=>jsonStatement(env.DB,sql,[])).toThrow();
});
