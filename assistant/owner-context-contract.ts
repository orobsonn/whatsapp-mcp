import type {SourceFence} from './access';
import type {ConversationFence} from './conversations';
import type {OriginScope} from './origin-guard';
/** Metadata only. The sole attempt/latch remains0026(source,revision). */
export type OwnerSupportProof={schema:'owner-canonical-supports-v1';scope:OriginScope;anchorConversation:ConversationFence|null;notes:{fence:SourceFence;conversation:ConversationFence|null}[]};
export type OwnerCatalogEntry={kind:'project'|'mission';id:string;revision:number;projectId:string|null;name:string;supports:{id:string;revision:number;version:number;hash:string;text:string}[]};
export type OwnerCanonicalStatus={schema:'owner-canonical-status-v1';state:'published'|'empty_catalog'|'blocked'|'uncertain';gap?:string;source:{id:string;revision:number;version:number;hash:string};observedAt:number};
