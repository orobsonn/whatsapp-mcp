-- READ ONLY. Run against production only with the owner's existing authorized account.
-- Does not read names, addresses, tokens, message bodies or media.
SELECT epoch,generation,kind,COUNT(*) AS total,SUM(capture_enabled) AS active,
 SUM(CASE WHEN capture_enabled=0 THEN 1 ELSE 0 END) AS inactive,
 SUM(CASE WHEN capture_enabled=0 AND (capture_since IS NOT NULL OR capture_discontinuous=1) THEN 1 ELSE 0 END) AS inactive_with_gap_markers
FROM chats GROUP BY epoch,generation,kind;
SELECT COUNT(*) AS applied_proposals_not_proof FROM policy_proposals WHERE status='applied';
SELECT value_json AS retention_days FROM policies WHERE key='retention_days';
