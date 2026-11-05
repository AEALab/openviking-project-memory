// Community modification (2026-11-05): project routing and configurable multi-library reads.
import {
  sanitizeCapturedText,
  truncateCaptureText,
  extractCaptureTurns as extractSharedCaptureTurns,
} from "./shared/capture-utils.mjs";

export * from "./shared/capture-utils.mjs";

const RETRIEVAL_OMITTED = "[OpenViking retrieved content omitted from memory capture]";

function mcpResultText(result) {
  const ok = result?.Ok;
  if (Array.isArray(ok?.content)) {
    const text = ok.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  if (typeof ok === "string") return ok;
  if (ok != null) return JSON.stringify(ok);
  const error = result?.Err;
  if (typeof error === "string") return error;
  return error == null ? "" : JSON.stringify(error);
}

function deduplicateMcpFunctionEvents(rolloutEntries) {
  const mcpCallIds = new Set(
    (rolloutEntries || [])
      .filter((entry) => entry?.payload?.type === "mcp_tool_call_end")
      .map((entry) => entry.payload.call_id)
      .filter(Boolean),
  );
  if (mcpCallIds.size === 0) return rolloutEntries || [];

  const duplicatedTypes = new Set([
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
  ]);
  return (rolloutEntries || []).filter((entry) => {
    const payload = entry?.payload;
    return !(
      duplicatedTypes.has(payload?.type)
      && mcpCallIds.has(payload.call_id || payload.id)
    );
  });
}

function agentMessageText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((part) => (
      (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text")
      && typeof part.text === "string"
    ))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function normalizeCodexNativeToolEvents(rolloutEntries) {
  return (rolloutEntries || []).map((entry) => {
    const payload = entry?.payload;
    if (entry?.type === "response_item" && payload?.type === "agent_message") {
      const text = agentMessageText(payload);
      const author = String(payload.author || "subagent");
      const recipient = String(payload.recipient || "main");
      return {
        ...entry,
        payload: {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: `[agent-message ${author} -> ${recipient}]${text ? `\n${text}` : ""}`,
          }],
        },
      };
    }
    if (payload?.type === "sub_agent_activity") {
      return {
        ...entry,
        payload: {
          type: "tool_result",
          call_id: `subagent-activity:${payload.event_id}`,
          name: "sub_agent_activity",
          output: {
            agent_thread_id: payload.agent_thread_id,
            agent_path: payload.agent_path,
            kind: payload.kind,
            occurred_at_ms: payload.occurred_at_ms,
          },
          status: "completed",
        },
      };
    }
    if (payload?.type === "custom_tool_call") {
      return {
        ...entry,
        payload: {
          type: "function_call",
          call_id: payload.call_id || payload.id,
          name: payload.name,
          arguments: payload.input,
        },
      };
    }
    if (payload?.type === "custom_tool_call_output") {
      return {
        ...entry,
        payload: {
          type: "function_call_output",
          call_id: payload.call_id || payload.id,
          output: payload.output,
        },
      };
    }
    if (payload?.type === "tool_search_call") {
      return {
        ...entry,
        payload: {
          type: "function_call",
          call_id: payload.call_id || payload.id,
          name: "tool_search",
          arguments: payload.arguments || {},
        },
      };
    }
    if (payload?.type === "tool_search_output") {
      return {
        ...entry,
        payload: {
          type: "function_call_output",
          call_id: payload.call_id || payload.id,
          output: JSON.stringify({ tools: payload.tools || [] }),
        },
      };
    }
    return entry;
  });
}

function normalizeCodexMcpToolEvents(rolloutEntries) {
  return (rolloutEntries || []).flatMap((entry) => {
    const payload = entry?.payload;
    if (payload?.type !== "mcp_tool_call_end") return [entry];

    const callId = payload.call_id;
    const toolName = payload.invocation?.tool;
    if (!callId || !toolName) return [entry];

    const call = {
      payload: {
        type: "function_call",
        id: callId,
        name: toolName,
        arguments: payload.invocation?.arguments || {},
      },
    };
    const output = mcpResultText(payload.result);
    const completed = (
      Object.prototype.hasOwnProperty.call(payload.result || {}, "Ok")
      && payload.result?.Ok?.isError !== true
    );
    const result = {
      payload: {
        type: "function_call_output",
        call_id: callId,
        ...(completed ? { output } : { error: output || "MCP tool call failed" }),
      },
    };
    return [call, result];
  });
}

function cleanCapturedMemoryText(text) {
  return sanitizeCapturedText(String(text || "")
    .replace(/<openviking-read-source\b[^>]*>[\s\S]*?<\/openviking-read-source>/gi, " "));
}

function isRetrievedMemoryOutput(part) {
  if (part.tool_name && !/(?:^|__)(?:find|search|read|list|tree|grep|glob|health)$/.test(part.tool_name)) return false;
  const sourceBlock = /^\s*<openviking-read-source\b[^>]*>/;
  if (typeof part.tool_output === "string" && sourceBlock.test(part.tool_output)) return true;
  try {
    const result = typeof part.tool_output === "string" ? JSON.parse(part.tool_output) : part.tool_output;
    return result?._meta?.openvikingRead === true
      || (Array.isArray(result?.content) && result.content.some((item) =>
        item.type === "text" && sourceBlock.test(item.text)));
  } catch { return false; }
}

export function extractCaptureTurns(rolloutEntries, cfg = {}) {
  const deduplicated = deduplicateMcpFunctionEvents(rolloutEntries);
  const normalized = normalizeCodexMcpToolEvents(normalizeCodexNativeToolEvents(deduplicated));
  const toolNames = new Map(normalized.map((entry) => entry?.payload || entry)
    .filter((payload) => payload?.type === "function_call")
    .map((payload) => [payload.call_id || payload.id, payload.name]));
  // Classify complete results before tool-output truncation can break their JSON structure.
  const entries = normalized.map((entry) => {
    const payload = entry?.payload || entry;
    if (payload?.type !== "function_call_output" || !isRetrievedMemoryOutput({
      tool_name: payload.name || payload.tool_name || payload.toolName || payload.tool
        || payload.function?.name || payload.call?.name || toolNames.get(payload.call_id),
      tool_output: payload.output,
    })) return entry;
    const redacted = { ...payload, output: RETRIEVAL_OMITTED };
    return entry.payload ? { ...entry, payload: redacted } : redacted;
  });
  const turns = extractSharedCaptureTurns(entries, cfg);
  return turns.map((turn) => {
    let remaining = Number(cfg.captureMaxLength) > 0 ? Number(cfg.captureMaxLength) : 24000;
    return {
      ...turn,
      text: turn.parts.some(isRetrievedMemoryOutput)
        ? RETRIEVAL_OMITTED : cleanCapturedMemoryText(turn.text),
      parts: turn.parts.flatMap((part) => {
        if (part.type === "text") {
          if (remaining <= 0) return [];
          const cleaned = cleanCapturedMemoryText(part.text) || "[OpenViking injected context omitted]";
          const text = truncateCaptureText(cleaned, remaining).slice(0, remaining);
          remaining -= text.length;
          return [{ ...part, text }];
        }
        if (isRetrievedMemoryOutput(part)) {
          return { ...part, tool_output: RETRIEVAL_OMITTED };
        }
        return part;
      }),
    };
  });
}

/**
 * Index of the last turn that came from a human prompt, or -1.
 *
 * `role === "user"` alone is not enough: normalizeCaptureRole() maps tool
 * results onto the user role too, and those carry `tool` parts rather than
 * `text` parts. Used by the post-compact shrink path to find where the current
 * interaction starts.
 */
export function findLastHumanTurnIndex(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const turn = list[i];
    if (turn?.role !== "user") continue;
    if (turn.parts?.some((part) => part?.type === "text")) return i;
  }
  return -1;
}
