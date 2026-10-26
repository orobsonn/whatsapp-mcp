import { afterEach, expect, it, vi } from "vitest";
import { checkOriginsWithin, type OriginFence } from "../assistant/origin-guard";
afterEach(()=>vi.useRealTimers());
const refs=()=>Array.from({length:64},(_,i)=>({canonicalId:String(i)} as OriginFence));
it("checks at most eight origins concurrently and completes all 64 before returning true",async()=>{
  let active=0,maximum=0,calls=0;const release:(()=>void)[]=[];
  const pending=checkOriginsWithin(refs(),async()=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>release.push(resolve));active--;return true;});
  for(let batch=0;batch<8;batch++){await Promise.resolve();expect(active).toBe(8);release.splice(0).forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();}
  expect(await pending).toBe(true);expect(calls).toBe(64);expect(maximum).toBe(8);
});
it("has a fixed total five-second deadline, starts no new checks after timeout and ignores late success",async()=>{
  vi.useFakeTimers();let calls=0;const release:(()=>void)[]=[];
  const pending=checkOriginsWithin(refs(),async()=>{calls++;await new Promise<void>(resolve=>release.push(resolve));return true;});
  expect(calls).toBe(8);await vi.advanceTimersByTimeAsync(4999);let settled=false;void pending.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(await pending).toBe(false);expect(calls).toBe(8);
  release.splice(0).forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();expect(calls).toBe(8);
});
