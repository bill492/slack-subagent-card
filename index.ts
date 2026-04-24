import {
  resolveConfiguredSecretInputWithFallback,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { WebClient } from "@slack/web-api";
import {
  registerSlackSubagentCardHandlers,
  type PluginApi,
} from "./plugin-handlers.js";

export default definePluginEntry({
  id: "slack-subagent-card",
  name: "Slack Subagent Card",
  description:
    "Posts and updates a Slack Block Kit status card for sub-agent work in Slack threads.",

  register(api: unknown) {
    const pluginApi = api as unknown as PluginApi & { config?: OpenClawConfig };
    registerSlackSubagentCardHandlers(Object.assign(pluginApi, {
      createSlackWebClient: (token: string) => new WebClient(token),
      resolveConfiguredSecretInputWithFallback,
    }));
  },
});
