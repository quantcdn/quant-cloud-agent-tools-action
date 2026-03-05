import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { Configuration, AICustomToolsApi, CreateCustomToolRequest } from '@quantcdn/quant-client';

const DEFAULT_BASE_URL = 'https://dashboard.quantcdn.io';

interface ToolConfig {
  toolName: string;
  description: string;
  category?: string;
  executionMode?: 'edge_function' | 'client';
  edgeFunctionUrl?: string;
  uuid?: string;
  isAsync?: boolean;
  responseMode?: 'direct' | 'llm';
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

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('quant_api_key', { required: true });
    const organization = core.getInput('quant_organization', { required: true });
    const toolsDir = core.getInput('tools_dir', { required: true });
    const baseUrl = core.getInput('base_url') || DEFAULT_BASE_URL;
    const previewDomain = core.getInput('preview_domain');
    const project = core.getInput('quant_project');

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

    // Fetch existing tools once for name-based matching.
    core.info('Fetching existing tools...');
    const existingTools = new Set<string>();
    try {
      const listResponse = await toolsApi.listCustomTools(organization);
      for (const tool of listResponse.data.tools || []) {
        if (tool.name) {
          existingTools.add(tool.name);
        }
      }
      core.info(`  Found ${existingTools.size} existing tool(s)`);
    } catch (err: any) {
      const message = err.response?.data?.error || err.message || String(err);
      core.setFailed(`Failed to list existing tools: ${message}`);
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

      const isUpdate = existingTools.has(toolConfig.toolName);
      core.info(`${isUpdate ? 'Updating' : 'Creating'} tool: ${toolConfig.toolName}`);

      // Map tool.json to SDK request. The SDK interface is a subset of what the
      // API accepts — spread the full config so extra fields (category,
      // executionMode, responseMode, etc.) are sent through to the API.
      // Build edgeFunctionUrl from UUID if preview_domain is configured
      let edgeFunctionUrl = toolConfig.edgeFunctionUrl || '';
      if (toolConfig.uuid && previewDomain && project) {
        edgeFunctionUrl = `https://${previewDomain}/_quant/ai-exec/${organization}/${project}/${toolConfig.uuid}`;
        core.info(`  Edge function URL: ${edgeFunctionUrl}`);
      } else if (toolConfig.uuid && (!previewDomain || !project)) {
        core.setFailed(`Tool ${toolConfig.toolName} has uuid but missing preview_domain or quant_project inputs`);
        return;
      }

      const request: CreateCustomToolRequest & Record<string, unknown> = {
        name: toolConfig.toolName,
        description: toolConfig.description,
        edgeFunctionUrl: edgeFunctionUrl,
        inputSchema: toolConfig.inputSchema,
        isAsync: toolConfig.isAsync,
        timeoutSeconds: toolConfig.timeout,
        // Pass through fields the SDK doesn't type but the API accepts.
        ...(toolConfig.category && { category: toolConfig.category }),
        ...(toolConfig.executionMode && { executionMode: toolConfig.executionMode }),
        ...(toolConfig.responseMode && { responseMode: toolConfig.responseMode }),
        ...(toolConfig.outputSchema && { outputSchema: toolConfig.outputSchema }),
        ...(toolConfig.outputSchemaDescription && { outputSchemaDescription: toolConfig.outputSchemaDescription }),
        ...(toolConfig.authConfig && { authConfig: toolConfig.authConfig }),
        ...(toolConfig.version && { version: toolConfig.version }),
      };

      try {
        await toolsApi.createCustomTool(organization, request);
        core.info(`  Tool ${isUpdate ? 'updated' : 'created'} successfully`);
        deployedTools.push({ toolName: toolConfig.toolName, created: !isUpdate });
      } catch (err: any) {
        const message = err.response?.data?.error || err.message || String(err);
        core.setFailed(`Failed to register tool ${toolConfig.toolName}: ${message}`);
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
