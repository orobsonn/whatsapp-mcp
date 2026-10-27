/** Fixed host protocol. Prefix is a permanent DENIAL marker, never Owner proof. */
export const OWNER_RELATION_PREFIX='canonical-owner-v2:';
export function ownerRelationKey(value:string){return /^canonical-owner-v2:[a-f0-9]{64}$/.test(value);}
/** Apply before LIMIT, aggregation and scoring. Missing metadata never promotes
 * an Owner key to source audience. SQL aliases come only from fixed host code. */
export function sourceRelationAudience(alias:'b'|'r'='b'){
 return `substr(${alias}.operation_key,1,19)<>'canonical-owner-v2:' AND NOT EXISTS(SELECT 1 FROM assistant_owner_relation_proofs owner_visibility WHERE owner_visibility.installation_id=${alias}.installation_id AND owner_visibility.generation=${alias}.generation AND owner_visibility.operation_key=${alias}.operation_key)`;
}
