// Explicitly bounded for an interactive shared Center; larger packages need a
// separately reviewed streaming design rather than raising these values.
export const MAX_ARCHIVE_BYTES=32*1024*1024;
export const MAX_SOCKET_FRAME_BYTES=48*1024*1024;
export const MAX_VERIFIER_OUTPUT_BYTES=64*1024*1024;

// Only these stable codes may cross the verifier/process boundary. Never expose
// arbitrary verifier stderr, which can contain paths or private source data.
const LIMIT_CODES=new Set(['archive_too_large','expanded_archive_too_large','evidence_too_large','metadata_too_large','archive_entries_exceeded','verifier_output_too_large']);
export function safeLimitCode(code){return typeof code==='string'&&LIMIT_CODES.has(code)?code:undefined;}
export function verifierLimitFromStderr(stderr){
 const match=/^PRIVATE_IMPORT_LIMIT:(archive_too_large|expanded_archive_too_large|evidence_too_large|metadata_too_large|archive_entries_exceeded|frame_too_large)\n?$/.exec(stderr);
 return match?.[1]==='frame_too_large'?'verifier_output_too_large':safeLimitCode(match?.[1]);
}
