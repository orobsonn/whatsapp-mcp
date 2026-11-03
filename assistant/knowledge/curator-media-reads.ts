import type {AccessGuard,SourceSelectionRef} from '../access';
import type {OriginScope} from '../origin-guard';
/** A host receipt is needed for raw attachments, including references obtained
 * outside curator_next. Text and actual transcript sources keep their own proof. */
export function curatorMediaReadGuard(scope:OriginScope,runId:string,ref:SourceSelectionRef,failed=false):AccessGuard{
 return {sql:`(NOT EXISTS(SELECT 1 FROM assistant_sources s WHERE s.installation_id=? AND s.generation=? AND s.id=? AND s.origin='whatsapp'
 AND NOT EXISTS(SELECT 1 FROM assistant_source_origins o JOIN assistant_origin_versions v ON v.installation_id=o.installation_id AND v.generation=o.generation AND v.canonical_id=o.canonical_id
  WHERE o.installation_id=s.installation_id AND o.generation=s.generation AND o.source_epoch=? AND o.source_generation=? AND o.canonical_id=s.id AND o.tombstoned=0 AND v.version=?
   AND ((o.source_kind='message' AND json_extract(CASE WHEN json_valid(v.dependencies_json) THEN v.dependencies_json ELSE '{}' END,'$.kind')='text')
    OR(o.source_kind='derivative' AND json_extract(CASE WHEN json_valid(v.dependencies_json) THEN v.dependencies_json ELSE '{}' END,'$.kind')='transcript'))))
 OR EXISTS(SELECT 1 FROM assistant_curator_media_reads m WHERE m.installation_id=? AND m.generation=? AND m.run_id=? AND m.source_id=? AND m.revision=? AND m.version=? AND m.source_hash=?
  AND ${failed?"(m.state<>'available' OR m.complete=0)":"m.state='available' AND m.complete=1"}))`,
 values:[scope.installationId,scope.generation,ref.id,scope.sourceEpoch,scope.sourceGeneration,ref.version,scope.installationId,scope.generation,runId,ref.id,ref.revision,ref.version,ref.hash]};
}
