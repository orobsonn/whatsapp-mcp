// Flue contributes runtime classes, never an implicit public agent router.
import { installEpisodeRuntime } from "./agent-runtime/install";
import { resolveInstalledRuntime } from "./agent-runtime/runtime";
import {installNativeConversations} from './agent-runtime/native-install';
installEpisodeRuntime(resolveInstalledRuntime,{install:installNativeConversations});
export { default } from "./index";
