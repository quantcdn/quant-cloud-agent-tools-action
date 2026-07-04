import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { Configuration, AICustomToolsApi, CreateCustomToolRequest } from '@quantcdn/quant-client';

const DEFAULT_BASE_URL = 'https://dashboard.quantcdn.io';

// The v3 endpoint validates timeoutSeconds within this range.
const TIMEOUT_MIN_SECONDS = 5;
const TIMEOUT_MAX_SECONDS = 300;

interface ToolConfig {
  toolName: string;
  description: string;
  category?: string;
  /** Deprecated — the platform deploys the edge function itself. Ignored. */
  executionMode?: 'edge_function' | 'client';
  /** Deprecated — the platform computes the edge function URL itself. Ignored. */
  edgeFunctionUrl?: string;
  /** Deprecated — the platform manages tool uuids. Informational only. */
  uuid?: string;
  isAsync?: boolean;
  responseMode?: 'direct' | 'llm';
  /** Timeout in seconds (5-300). Values > 300 are assumed to be milliseconds and converted. */
  timeout?: number;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  outputSchemaDescription?: string;
  authConfig?: {
    type: 'bearer' | 'api-key' | 'none';
    secretName?: string;
  };
  version?: string;
}

interface DeployedTool {
  toolName: string;
  created: boolean;
}

/**
 * The request shape the v3 create-custom-tool endpoint actually validates.
 *
 * The generated `CreateCustomToolRequest` type in @quantcdn/quant-client is out
 * of date: it requires `edgeFunctionUrl`, but the endpoint requires
 * `edgeFunctionCode` instead — the platform deploys the edge function itself,
 * computes the URL, and registers the tool under it.
 */
interface CustomToolRequest {
  toolName: string;
  description: string;
  edgeFunctionCode: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  responseMode?: 'direct' | 'llm';
  outputSchema?: Record<string, unknown>;
  outputSchemaDescription?: string;
  isAsync?: boolean;
  timeoutSeconds?: number;
}

/**
 * Extract HTTP status and the full JSON response body from an axios-style
 * error. Laravel validation failures return `{ errors: { field: [...] } }` —
 * reading only `.error` (as this action previously did) loses everything.
 */
function formatApiError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const response = (err as { response?: { status?: number; data?: unknown } }).response;
    if (response) {
      const status = response.status !== undefined ? `HTTP ${response.status}` : 'HTTP error';
      const body = response.data !== undefined ? JSON.stringify(response.data) : '(no response body)';
      return `${status}: ${body}`;
    }
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Normalize tool.json `timeout` to seconds for the API's `timeoutSeconds`
 * field. The unit is seconds; values above the API maximum (300) are assumed
 * to be milliseconds from older configs and converted with a warning.
 * Returns undefined (and fails the action) on out-of-range values.
 */
function resolveTimeoutSeconds(toolName: string, timeout: number): number | undefined {
  let seconds = timeout;
  if (seconds > TIMEOUT_MAX_SECONDS) {
    seconds = Math.round(seconds / 1000);
    core.warning(
      `Tool ${toolName}: timeout ${timeout} exceeds the ${TIMEOUT_MAX_SECONDS}s maximum — ` +
      `assuming milliseconds and converting to ${seconds}s. Specify timeout in seconds.`
    );
  }
  if (seconds < TIMEOUT_MIN_SECONDS || seconds > TIMEOUT_MAX_SECONDS) {
    core.setFailed(
      `Tool ${toolName}: timeout must resolve to ${TIMEOUT_MIN_SECONDS}-${TIMEOUT_MAX_SECONDS} seconds (got ${seconds})`
    );
    return undefined;
  }
  return seconds;
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('quant_api_key', { required: true });
    const organization = core.getInput('quant_organization', { required: true });
    const toolsDir = core.getInput('tools_dir', { required: true });
    const baseUrl = core.getInput('base_url') || DEFAULT_BASE_URL;

    // Deprecated inputs — the platform now deploys edge functions and computes
    // their URLs itself, so these are no longer used. Accepted (not removed
    // from action.yml) so existing workflows don't break.
    if (core.getInput('preview_domain')) {
      core.warning('Input preview_domain is deprecated and ignored — the platform computes edge function URLs.');
    }
    if (core.getInput('quant_project')) {
      core.warning('Input quant_project is deprecated and ignored — the platform computes edge function URLs.');
    }

    // The SDK appends /api/v3/... paths internally, so strip it if provided.
    const basePath = baseUrl.replace(/\/api\/v3\/?$/, '');

    const config = new Configuration({
      basePath,
      accessToken: apiKey,
    });
    const toolsApi = new AICustomToolsApi(config);

    const resolvedDir = path.resolve(toolsDir);
    if (!fs.existsSync(resolvedDir)) {
      core.setFailed(`Tools directory not found: ${resolvedDir}`);
      return;
    }

    // Fetch existing tools once for accurate created/updated reporting and to
    // fail fast on auth problems. Note the create endpoint upserts by name
    // regardless — this list is not required for correctness.
    core.info('Fetching existing tools...');
    const existingTools = new Set<string>();
    try {
      const listResponse = await toolsApi.listCustomTools(organization);
      for (const tool of listResponse.data.tools || []) {
        // The API returns `toolName`; the generated SDK type says `name`.
        // Read both to be safe against either shape.
        const name = (tool as Record<string, unknown>).toolName ?? tool.name;
        if (typeof name === 'string' && name) {
          existingTools.add(name);
        }
      }
      core.info(`  Found ${existingTools.size} existing tool(s)`);
    } catch (err: unknown) {
      core.setFailed(`Failed to list existing tools: ${formatApiError(err)}`);
      return;
    }

    const deployedTools: DeployedTool[] = [];

    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const toolDir = path.join(resolvedDir, entry.name);
      const configPath = path.join(toolDir, 'tool.json');

      if (!fs.existsSync(configPath)) {
        core.warning(`Skipping ${entry.name}: no tool.json found`);
        continue;
      }

      const toolConfig: ToolConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      if (!toolConfig.toolName || !toolConfig.description || !toolConfig.inputSchema) {
        core.setFailed(`Tool in ${entry.name}: missing required fields (toolName, description, inputSchema)`);
        return;
      }

      // Convention: each tool directory contains fn.js — the edge function
      // source deployed by the platform when the tool is registered.
      const fnPath = path.join(toolDir, 'fn.js');
      if (!fs.existsSync(fnPath)) {
        core.setFailed(
          `Tool ${toolConfig.toolName}: missing fn.js in ${toolDir}. ` +
          `Each tool directory must contain fn.js (the edge function source) alongside tool.json — ` +
          `the platform deploys it and registers the tool against the deployed function.`
        );
        return;
      }
      const edgeFunctionCode = fs.readFileSync(fnPath, 'utf-8');

      if (toolConfig.uuid) {
        core.warning(
          `Tool ${toolConfig.toolName}: tool.json "uuid" is informational only — the platform manages ` +
          `edge function uuids, reusing the existing tool's uuid on update.`
        );
      }

      const isUpdate = existingTools.has(toolConfig.toolName);
      core.info(`${isUpdate ? 'Updating' : 'Creating'} tool: ${toolConfig.toolName}`);

      const request: CustomToolRequest = {
        toolName: toolConfig.toolName,
        description: toolConfig.description,
        edgeFunctionCode,
        inputSchema: toolConfig.inputSchema,
        ...(toolConfig.category !== undefined && { category: toolConfig.category }),
        ...(toolConfig.responseMode !== undefined && { responseMode: toolConfig.responseMode }),
        ...(toolConfig.outputSchema !== undefined && { outputSchema: toolConfig.outputSchema }),
        ...(toolConfig.outputSchemaDescription !== undefined && {
          outputSchemaDescription: toolConfig.outputSchemaDescription,
        }),
        ...(toolConfig.isAsync !== undefined && { isAsync: toolConfig.isAsync }),
      };

      if (toolConfig.timeout !== undefined) {
        const timeoutSeconds = resolveTimeoutSeconds(toolConfig.toolName, toolConfig.timeout);
        if (timeoutSeconds === undefined) return;
        request.timeoutSeconds = timeoutSeconds;
      }

      try {
        // Cast: the generated SDK request type is stale (requires
        // edgeFunctionUrl, missing edgeFunctionCode) — see CustomToolRequest.
        // The endpoint upserts by name: existing tools are updated in place
        // and their edge function code redeployed under the same uuid.
        await toolsApi.createCustomTool(organization, request as unknown as CreateCustomToolRequest);
        core.info(`  Tool ${isUpdate ? 'updated' : 'created'} successfully`);
        deployedTools.push({ toolName: toolConfig.toolName, created: !isUpdate });
      } catch (err: unknown) {
        core.setFailed(`Failed to register tool ${toolConfig.toolName}: ${formatApiError(err)}`);
        return;
      }
    }

    core.setOutput('deployed_tools', JSON.stringify(deployedTools.map(t => t.toolName)));

    core.info('');
    core.info('=== Tools Deploy Summary ===');
    for (const tool of deployedTools) {
      core.info(`  ${tool.created ? 'Created' : 'Updated'}: ${tool.toolName}`);
    }
  } catch (error) {
    core.setFailed(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

run();
